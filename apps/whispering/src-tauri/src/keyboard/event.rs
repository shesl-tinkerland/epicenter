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

/// Emitted when the rdev listener thread exits. The frontend treats this as a
/// liveness signal and asks the idempotent start command to respawn the thread
/// once shortcuts are still allowed.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct ListenerStoppedEvent {
    pub error: Option<String>,
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

    #[test]
    fn listener_stopped_event_wire_shape_is_camel_case() {
        let event = ListenerStoppedEvent {
            error: Some("permission revoked".to_string()),
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({ "error": "permission revoked" })
        );
    }
}
