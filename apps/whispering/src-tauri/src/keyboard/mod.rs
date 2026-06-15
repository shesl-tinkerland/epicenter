//! Desktop global keyboard trigger backend.
//!
//! A single low-level `rdev::listen` hook sees every key down/up system-wide,
//! including the Fn key and modifier-only chords that the Tauri
//! global-shortcut plugin cannot. The pure `matcher` turns that event stream
//! into `{ commandId, state }` transitions that the FE registrar feeds into the
//! existing command layer (`commands.ts`), which is unchanged.
//!
//! Layering, so the complex part stays testable:
//! - `keys`     the binding model (our own `Modifier` / `Key`, physical-key space)
//! - `matcher`  held-set tracking and press/release transitions (pure, unit-tested)
//! - `rdev_map` the only rdev-coupled code: `rdev::Key` -> matcher `Input`
//! - `event`    the wire payload emitted to the FE
//!
//! Wiring: the `set_keyboard_shortcuts` command pushes the user's bindings and
//! the FE registrar dispatches the emitted events. The FE calls
//! `start_keyboard_listener` once it knows global shortcuts are allowed (macOS
//! Accessibility granted, or any non-macOS desktop), so the listener is never
//! spawned before `rdev::listen` can actually tap the keyboard. This mirrors
//! `cjpais/Handy`, which gates the listener on the frontend's permission check
//! rather than polling `listen` from Rust.

pub mod commands;
pub mod event;
pub mod keys;
pub mod matcher;
mod rdev_map;

pub use event::{ShortcutCaptureEvent, ShortcutTriggerEvent, TriggerState};
pub use keys::{Key, KeyBinding, Modifier};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_specta::Event;

use matcher::{Edge, Matcher};

/// The window the trigger/capture events are delivered to. We target it
/// explicitly instead of broadcasting so the overlay and picker webviews never
/// see shortcut events, which keeps the dispatch single even if they subscribe.
const MAIN_WINDOW: &str = "main";

/// Outcome of a `start` request, so the FE can tell the user when global
/// shortcuts are unavailable instead of relying on a Rust log nobody sees.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ListenerStart {
    /// A listener thread was spawned.
    Started,
    /// A listener thread is already running; this call was a no-op.
    AlreadyRunning,
    /// Linux Wayland: rdev's tap never receives events, so nothing was spawned.
    WaylandUnsupported,
}

/// rdev's listener is X11-only; on Wayland the tap never receives events.
#[cfg(target_os = "linux")]
fn is_wayland() -> bool {
    std::env::var("XDG_SESSION_TYPE")
        .map(|value| value.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
        || std::env::var("WAYLAND_DISPLAY").is_ok()
}

/// Owns the registered bindings and the rdev listener thread. Constructed in
/// `setup` with an `AppHandle` (mirrors `ModelManager`) and managed via
/// `app.manage(...)` so commands can reach it with `app.state::<...>()`.
pub struct KeyboardListener {
    app: AppHandle,
    matcher: Arc<Mutex<Matcher>>,
    /// Whether a listener thread is live. Guards against spawning a second
    /// `rdev::listen` (which would double-fire every trigger). Reset to false
    /// when the thread exits so a later `start` can retry.
    running: Arc<AtomicBool>,
}

impl KeyboardListener {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            matcher: Arc::new(Mutex::new(Matcher::new())),
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Replace the full set of registered bindings. Called from the FE registrar
    /// whenever the user's configured global shortcuts change. Poisoned lock is
    /// swallowed: a panicked matcher thread should not take the app down.
    pub fn set_bindings(&self, bindings: Vec<(String, KeyBinding)>) {
        if let Ok(mut matcher) = self.matcher.lock() {
            matcher.set_bindings(bindings);
        }
    }

    /// Enter or leave capture mode. While capturing, the listener forwards the
    /// held combo to the settings recorder as a `ShortcutCaptureEvent` instead
    /// of matching registered bindings (see `Matcher::set_capturing`).
    pub fn set_capturing(&self, capturing: bool) {
        if let Ok(mut matcher) = self.matcher.lock() {
            matcher.set_capturing(capturing);
        }
    }

    /// Spawn the rdev listener once, if it is not already running. The FE calls
    /// this through `start_keyboard_listener` when it knows global shortcuts are
    /// allowed (macOS Accessibility granted, or any non-macOS desktop), so
    /// `rdev::listen` can actually create the tap. `listen` is a passive listen
    /// (not `grab`, so keystrokes still reach the foreground app) and blocks
    /// until it errors; if it does exit (focus loss, permission revoked) the
    /// thread resets `running` so a later `start` can retry.
    ///
    /// Idempotent: the `running` guard means a second call while a thread is
    /// live is a no-op, so the FE can call this freely (on launch and on every
    /// Accessibility re-check) without ever spawning two listeners.
    pub fn start(&self) -> ListenerStart {
        #[cfg(target_os = "linux")]
        if is_wayland() {
            return ListenerStart::WaylandUnsupported;
        }

        if self.running.swap(true, Ordering::SeqCst) {
            return ListenerStart::AlreadyRunning;
        }

        let app = self.app.clone();
        let matcher = self.matcher.clone();
        let running = self.running.clone();
        std::thread::Builder::new()
            .name("rdev-keyboard-listener".into())
            .spawn(move || {
                // A previous attempt that exited may have left a key in the held
                // set with no matching release; start clean so a stale modifier
                // cannot wedge a binding "down" under exact-set matching.
                if let Ok(mut matcher) = matcher.lock() {
                    matcher.clear_held();
                }

                let result = rdev::listen(move |event| {
                    let (edge, key) = match event.event_type {
                        rdev::EventType::KeyPress(key) => (Edge::Press, key),
                        rdev::EventType::KeyRelease(key) => (Edge::Release, key),
                        _ => return,
                    };
                    let Some(input) = rdev_map::classify(key) else {
                        return;
                    };

                    // Hold the lock only to resolve the event; emit after dropping
                    // it so a subscriber callback can never deadlock the listener.
                    let triggers = {
                        let Ok(mut matcher) = matcher.lock() else {
                            return;
                        };
                        let triggers = matcher.on_event(edge, input);
                        // In capture mode the recorder wants the live held combo,
                        // not command triggers (which `on_event` suppresses).
                        if matcher.is_capturing() {
                            let binding = matcher.held_binding();
                            drop(matcher);
                            let _ = ShortcutCaptureEvent { binding }.emit_to(&app, MAIN_WINDOW);
                            return;
                        }
                        triggers
                    };

                    for trigger in triggers {
                        let _ = trigger.emit_to(&app, MAIN_WINDOW);
                    }
                });
                if let Err(error) = result {
                    log::error!("rdev keyboard listener stopped: {error:?}");
                }
                // Allow a later `start` (e.g. the FE re-checking on focus) to
                // respawn after a transient exit.
                running.store(false, Ordering::SeqCst);
            })
            .expect("failed to spawn rdev keyboard listener thread");

        ListenerStart::Started
    }
}
