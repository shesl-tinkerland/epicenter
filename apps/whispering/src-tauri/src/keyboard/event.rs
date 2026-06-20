use super::keys::KeyBinding;
use serde::{Deserialize, Serialize};

/// Whether a binding just became fully held (`Pressed`) or stopped being fully
/// held (`Released`). The variant names serialize verbatim to `"Pressed"` /
/// `"Released"`, which is exactly the `ShortcutEventState` the Tauri
/// global-shortcut plugin used to deliver, so the command layer (`commands.ts`)
/// is unchanged: only the producer of these strings changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub enum TriggerState {
    Pressed,
    Released,
}

/// Emitted on every binding transition. `command_id` is the id the binding was
/// registered under; the FE filters by that command's `on` array and dispatches
/// the callback. Rust stays command-agnostic: it knows the id and the edge, not
/// which states a given command cares about.
///
/// A `tauri_specta::Event`, so the listener emits it with
/// `trigger.emit_to(app, MAIN_WINDOW)` (targeting the main webview, not the
/// overlay) and the FE listens through the generated `events.shortcutTriggerEvent`.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutTriggerEvent {
    pub command_id: String,
    pub state: TriggerState,
}

/// Streamed on every change of the currently-held combo while the settings
/// recorder is capturing a new binding. A dedicated event type (rather than
/// emitting a bare `KeyBinding`) so capture is a `tauri_specta::Event` like the
/// trigger, with a generated topic and FE binding. Recording goes through rdev,
/// not the webview, because only rdev sees the Fn key and physical-key
/// positions, so the captured binding is exactly what the matcher will later
/// match. The FE accumulates these snapshots and commits when all keys release.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutCaptureEvent {
    pub binding: KeyBinding,
}

/// The single source of truth for whether Whispering can drive its headline
/// "dictate anywhere" flow: tap the keyboard for global shortcuts and paste a
/// transcript back. macOS gates that on Accessibility trust, and the only
/// process that can authoritatively know it is the one holding the rdev tap
/// (this one), so Rust owns this value and the frontend is a pure view over it.
///
/// It folds two facts the frontend used to infer separately: the macOS trust
/// probe (`AXIsProcessTrusted`) and the tap's liveness. Crucially `Broken` is
/// distinguishable from `Active` only here, because `AXIsProcessTrusted` reports
/// a stale post-update grant as trusted: the tap dying under a held grant is the
/// only signal that tells them apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DictationCapability {
    /// The supervisor has not determined the value yet. Rust resolves this
    /// synchronously at startup, so it exists only as the frontend's pre-seed
    /// initial value before the first probe lands.
    Unknown,
    /// This platform can never tap the keyboard (Linux Wayland: `rdev::listen`
    /// receives no events). Terminal for the session.
    Unsupported,
    /// No bound shortcut needs the tap (no Fn or modifier-only binding), so it is
    /// deliberately not running and no Accessibility is touched. This is the
    /// permission-free floor: chords go through the global-shortcut plugin and
    /// the tap stays dormant until the user opts into a binding that needs it.
    Inactive,
    /// macOS Accessibility is not granted. The tap is not running; turning
    /// Whispering on in System Settings unlocks it.
    Untrusted,
    /// The tap is running and (on macOS) the app is trusted. Dictation works.
    Active,
    /// macOS reports the app trusted, but the tap keeps dying under the held
    /// grant: a stale post-update signature. Removing and re-adding Whispering
    /// in Accessibility is the fix, which `Untrusted`'s "just toggle on" is not.
    Broken,
}

/// Pushed whenever the dictation capability changes. The frontend seeds from
/// `get_dictation_capability` on attach, then tracks this event for transitions;
/// it never probes the OS itself. A `tauri_specta::Event`, emitted with
/// `emit_to(app, MAIN_WINDOW)` (the main webview, not the overlay) and listened
/// through the generated `events.dictationCapabilityEvent`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct DictationCapabilityEvent {
    pub capability: DictationCapability,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trigger_state_serializes_to_the_plugins_pascalcase_strings() {
        // The whole point of matching this wire shape: `commands.ts` keeps
        // comparing against 'Pressed' | 'Released' with no change.
        assert_eq!(
            serde_json::to_value(TriggerState::Pressed).unwrap(),
            json!("Pressed")
        );
        assert_eq!(
            serde_json::to_value(TriggerState::Released).unwrap(),
            json!("Released")
        );
    }

    #[test]
    fn trigger_event_wire_shape_is_camel_case() {
        let event = ShortcutTriggerEvent {
            command_id: "pushToTalk".to_string(),
            state: TriggerState::Pressed,
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({ "commandId": "pushToTalk", "state": "Pressed" })
        );
    }
}
