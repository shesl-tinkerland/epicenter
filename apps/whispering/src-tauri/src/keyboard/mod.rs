//! Desktop global keyboard trigger backend: the opt-in Tier-1 tap.
//!
//! Tier 0, the permission-free floor, is the global-shortcut plugin (registered
//! on the FE); it handles plain chords with no Accessibility grant. This module
//! is Tier 1: a low-level keyboard tap that sees the Fn key and modifier-only
//! chords the plugin cannot, the holds good push-to-talk needs. It runs ONLY
//! when a bound shortcut needs it, so a chord-only setup never touches
//! Accessibility. The pure `matcher` turns the tap's event stream into
//! `{ commandId, state }` transitions that the FE registrar feeds into the
//! existing command layer (`commands.ts`), which is unchanged.
//!
//! Layering, so the complex part stays testable:
//! - `keys`     the binding model (our own `Modifier` / `Key`, physical-key space)
//! - `matcher`  held-set tracking and press/release transitions (pure, unit-tested)
//! - `mac_tap`  the macOS tap (owned CGEventTap), normalizing to matcher `Input`
//! - `rdev_map` the non-macOS path: `rdev::Key` -> matcher `Input`
//! - `event`    the wire payload emitted to the FE
//!
//! Wiring: the `set_keyboard_shortcuts` command pushes the tap-needing bindings
//! and the FE registrar dispatches the emitted events. A Rust-owned supervisor
//! (see `run_supervisor`) owns the tap's whole lifecycle: it spins the tap up
//! only when a binding needs it, gates spawning on the live macOS Accessibility
//! trust (`AXIsProcessTrusted`), restarts a tap that dies under a held grant, and
//! publishes the resulting `DictationCapability` so the frontend is a pure view
//! over one value instead of inferring liveness and polling trust itself. The
//! trust fact belongs to the process that holds the tap; that is this one, so
//! this is where it lives.

pub mod commands;
pub mod event;
pub mod keys;
/// macOS owns its tap (`mac_tap`); every other desktop drives `rdev::listen` via
/// `rdev_map`. Exactly one backend is compiled per platform.
#[cfg(target_os = "macos")]
mod mac_tap;
pub mod matcher;
#[cfg(not(target_os = "macos"))]
mod rdev_map;
mod supervisor;

pub use event::{
    DictationCapability, DictationCapabilityEvent, ShortcutCaptureEvent, ShortcutTriggerEvent,
    TriggerState,
};
pub use keys::{Key, KeyBinding, Modifier};

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri_specta::Event;

use matcher::{Edge, Input, Matcher};
use supervisor::{Control, Effect, Supervisor};

/// The window the trigger/capture events are delivered to. We target it
/// explicitly instead of broadcasting so the overlay and picker webviews never
/// see shortcut events, which keeps the dispatch single even if they subscribe.
const MAIN_WINDOW: &str = "main";

/// rdev's listener is X11-only; on Wayland the tap never receives events.
#[cfg(target_os = "linux")]
fn is_wayland() -> bool {
    std::env::var("XDG_SESSION_TYPE")
        .map(|value| value.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
        || std::env::var("WAYLAND_DISPLAY").is_ok()
}

/// Whether this process may currently tap the keyboard. On macOS this is the
/// live Accessibility check (`AXIsProcessTrusted`); every other desktop has no
/// such gate, so the tap is always allowed.
fn is_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: `AXIsProcessTrusted` is an argument-free, thread-safe TCC query
        // with no side effects (unlike the `WithOptions` form, it never prompts).
        unsafe { accessibility_sys::AXIsProcessTrusted() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// The command-facing handle to the keyboard tap: owns the registered bindings
/// and the current dictation capability, and forwards intent changes to the
/// supervisor. The tap thread itself is owned by a supervisor spawned in `new`
/// (see `run_supervisor`); this struct is constructed in `setup` and managed via
/// `app.manage(...)` so commands reach it with `app.state::<...>()`.
pub struct TapController {
    matcher: Arc<Mutex<Matcher>>,
    capability: Arc<Mutex<DictationCapability>>,
    /// Wakes the supervisor when the bound set changes, so it can start the tap
    /// the moment a Tier-1 binding appears and stop it when the last one leaves.
    control_tx: Sender<Control>,
}

impl TapController {
    pub fn new(app: AppHandle) -> Self {
        let matcher = Arc::new(Mutex::new(Matcher::new()));
        let capability = Arc::new(Mutex::new(DictationCapability::Unknown));
        let (control_tx, control_rx) = mpsc::channel();
        spawn_supervisor(
            app,
            matcher.clone(),
            capability.clone(),
            control_tx.clone(),
            control_rx,
        );
        Self {
            matcher,
            capability,
            control_tx,
        }
    }

    /// Replace the full set of registered bindings. The FE pushes only the
    /// bindings the tap must own (Fn and modifier-only holds); chords go to the
    /// global-shortcut plugin instead. So a non-empty set means "the tap is
    /// needed": we tell the supervisor, which spins the tap up (or, when the set
    /// empties, tears it down so the floor touches no Accessibility). Poisoned
    /// lock is swallowed: a panicked matcher thread should not take the app down.
    pub fn set_bindings(&self, bindings: Vec<(String, KeyBinding)>) {
        let needs_tap = bindings.iter().any(|(_, binding)| !binding.is_empty());
        if let Ok(mut matcher) = self.matcher.lock() {
            matcher.set_bindings(bindings);
        }
        let _ = self.control_tx.send(Control::Bindings(needs_tap));
    }

    /// Tell the supervisor whether auto-paste-at-cursor is enabled. It writes via
    /// the same macOS Accessibility grant the tap reads through, so when it is on
    /// the tap is held to track that grant (and surface the notice if it is
    /// missing) even with no binding. Pushed by the FE on launch and on change.
    pub fn set_auto_paste_enabled(&self, enabled: bool) {
        let _ = self.control_tx.send(Control::AutoPaste(enabled));
    }

    /// Enter or leave capture mode. While capturing, the tap forwards the held
    /// combo to the settings recorder as a `ShortcutCaptureEvent` instead of
    /// matching registered bindings (see `Matcher::set_capturing`).
    ///
    /// Capture is also a reason to hold the tap: recording an Fn or modifier-only
    /// binding needs the tap running to read the keys, but from the permission-free
    /// floor no binding is bound yet, so the tap is dormant. Telling the supervisor
    /// spins it up for the duration of capture (gated on trust, so an untrusted
    /// user is routed to grant Accessibility first), which is the only way the
    /// first Fn binding is ever recordable. The matcher flag is set first so the
    /// freshly-spawned tap is already in capture mode when its events arrive.
    pub fn set_capturing(&self, capturing: bool) {
        if let Ok(mut matcher) = self.matcher.lock() {
            matcher.set_capturing(capturing);
        }
        let _ = self.control_tx.send(Control::Capturing(capturing));
    }

    /// The current dictation capability, for the FE's seed on attach.
    pub fn capability(&self) -> DictationCapability {
        self.capability
            .lock()
            .map(|c| *c)
            .unwrap_or(DictationCapability::Unknown)
    }
}

/// Store the new capability and, if it changed, push it to the frontend. The
/// supervisor is the only writer, so the compare-and-emit needs no extra
/// synchronization beyond the cell's own lock.
fn set_capability(
    app: &AppHandle,
    cell: &Arc<Mutex<DictationCapability>>,
    next: DictationCapability,
) {
    if let Ok(mut current) = cell.lock() {
        if *current == next {
            return;
        }
        *current = next;
    }
    let _ = DictationCapabilityEvent { capability: next }.emit_to(app, MAIN_WINDOW);
}

/// Resolve one normalized key transition and emit whatever it produces. The
/// single convergence point both backends feed: `mac_tap` (macOS) and
/// `rdev::listen` (elsewhere) each normalize their platform events to
/// `(Edge, Input)` and hand them here, so the matcher, capture, and trigger
/// emit live in one place regardless of backend.
fn handle_event(app: &AppHandle, matcher: &Arc<Mutex<Matcher>>, edge: Edge, input: Input) {
    // Hold the lock only to resolve the event; emit after dropping it so a
    // subscriber callback can never deadlock the tap.
    let triggers = {
        let Ok(mut matcher) = matcher.lock() else {
            return;
        };
        let triggers = matcher.on_event(edge, input);
        // In capture mode the recorder wants the live held combo, not command
        // triggers (which `on_event` suppresses).
        if matcher.is_capturing() {
            let binding = matcher.held_binding();
            drop(matcher);
            let _ = ShortcutCaptureEvent { binding }.emit_to(app, MAIN_WINDOW);
            return;
        }
        triggers
    };

    for trigger in triggers {
        let _ = trigger.emit_to(app, MAIN_WINDOW);
    }
}

/// Run the platform tap on the calling thread until it stops, feeding every
/// transition to `handle_event`. Returns the debug-formatted stop reason (log
/// only), or `None` on a clean stop. This is the one platform fork: macOS uses
/// the owned `mac_tap`, everything else uses `rdev::listen` via `rdev_map`.
#[cfg(target_os = "macos")]
fn run_listen(app: &AppHandle, matcher: &Arc<Mutex<Matcher>>) -> Option<String> {
    let app = app.clone();
    let matcher = matcher.clone();
    mac_tap::listen(move |edge, input| handle_event(&app, &matcher, edge, input))
        .err()
        .map(|error| format!("{error:?}"))
}

#[cfg(not(target_os = "macos"))]
fn run_listen(app: &AppHandle, matcher: &Arc<Mutex<Matcher>>) -> Option<String> {
    let app = app.clone();
    let matcher = matcher.clone();
    rdev::listen(move |event| {
        let (edge, key) = match event.event_type {
            rdev::EventType::KeyPress(key) => (Edge::Press, key),
            rdev::EventType::KeyRelease(key) => (Edge::Release, key),
            _ => return,
        };
        let Some(input) = rdev_map::classify(key) else {
            return;
        };
        handle_event(&app, &matcher, edge, input);
    })
    .err()
    .map(|error| format!("{error:?}"))
}

/// Spawn one tap thread. It runs until `run_listen` returns (a tap break, a
/// revoked grant, or a stale signature), then reports its exit over `control_tx`.
/// The tap is passive (not `grab`, so keystrokes still reach the foreground app).
/// The supervisor is the only caller and serializes spawns, so there is no
/// running-guard: exactly one tap thread is ever live at a time.
fn spawn_listener(app: &AppHandle, matcher: &Arc<Mutex<Matcher>>, control_tx: &Sender<Control>) {
    let app = app.clone();
    let matcher = matcher.clone();
    let control_tx = control_tx.clone();
    std::thread::Builder::new()
        .name("keyboard-listener".into())
        .spawn(move || {
            // A previous tap that exited may have left a key in the held set with
            // no matching release; start clean so a stale modifier cannot wedge a
            // binding "down" under exact-set matching.
            if let Ok(mut matcher) = matcher.lock() {
                matcher.clear_held();
            }

            if let Some(reason) = run_listen(&app, &matcher) {
                log::error!("keyboard listener stopped: {reason}");
            }
            // Hand the exit to the supervisor, which decides what it means
            // (revoked grant vs requested stop vs transient death vs stale
            // signature) and whether to restart. The reason is logged here, so
            // the signal itself carries no payload.
            let _ = control_tx.send(Control::TapStopped);
        })
        .expect("failed to spawn keyboard listener thread");
}

/// Ask the live tap (if any) to stop. On macOS this returns `mac_tap::listen`
/// from its blocking loop, which lands as a `Control::TapStopped` the supervisor
/// settles to `Inactive`. `rdev::listen` has no stop, so elsewhere the thread
/// lingers with an empty binding set (it emits nothing); there is no
/// Accessibility cost off macOS, so a dormant thread is harmless.
fn request_tap_stop() {
    #[cfg(target_os = "macos")]
    mac_tap::stop();
}

fn spawn_supervisor(
    app: AppHandle,
    matcher: Arc<Mutex<Matcher>>,
    capability: Arc<Mutex<DictationCapability>>,
    control_tx: Sender<Control>,
    control_rx: std::sync::mpsc::Receiver<Control>,
) {
    std::thread::Builder::new()
        .name("dictation-capability-supervisor".into())
        .spawn(move || run_supervisor(app, matcher, capability, control_tx, control_rx))
        .expect("failed to spawn dictation capability supervisor thread");
}

/// The owning loop around [`Supervisor`]: it performs the I/O the pure decision
/// core cannot. Each turn it waits for a control message (or a bounded timeout),
/// samples `AXIsProcessTrusted`, steps the supervisor, and runs whatever the step
/// returned: spawn or stop the tap, publish the capability, and arm the next
/// wait. The supervisor decides; this loop acts, so exactly one tap is ever live
/// (spawns are serialized here).
///
/// Three facts the design rests on: the tap is only needed when something wants
/// the grant (a Tier-1 binding, auto-paste, or an in-progress capture; chords go
/// to the plugin), `mac_tap`/`rdev` give a thread-death signal but no positive
/// "alive" signal, and macOS gives no event when Accessibility flips. So the tap
/// is spawned only while wanted AND trusted (an untrusted tap silently drops
/// events, looking alive); its liveness is the death channel; and the grant is
/// sampled by a bounded poll that runs only while we want the tap but cannot run
/// it. All of it lives here, beside the tap, instead of being smeared across the
/// webview.
fn run_supervisor(
    app: AppHandle,
    matcher: Arc<Mutex<Matcher>>,
    capability: Arc<Mutex<DictationCapability>>,
    control_tx: Sender<Control>,
    control_rx: std::sync::mpsc::Receiver<Control>,
) {
    #[cfg(target_os = "linux")]
    if is_wayland() {
        set_capability(&app, &capability, DictationCapability::Unsupported);
        return;
    }

    let mut supervisor = Supervisor::new();
    // Monotonic clock for the restart-reset window; only the delta matters, so a
    // process-relative millisecond count is enough and keeps the core testable.
    let start = Instant::now();

    // Start dormant: nothing wants the grant yet, so the tap does not run and no
    // Accessibility is touched. The FE pushes the bound set and auto-paste state
    // on launch, which wakes us via `Control::Bindings` / `Control::AutoPaste`.
    set_capability(&app, &capability, DictationCapability::Inactive);

    // `None` blocks until a control message; `Some(d)` waits at most `d`, after
    // which a `None` control means the wait elapsed (a grant poll or an elapsed
    // restart backoff, told apart by the supervisor's own state).
    let mut next_timeout: Option<Duration> = None;
    loop {
        let control = match next_timeout {
            None => match control_rx.recv() {
                Ok(control) => Some(control),
                Err(_) => return,
            },
            Some(delay) => match control_rx.recv_timeout(delay) {
                Ok(control) => Some(control),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            },
        };

        let now_ms = start.elapsed().as_millis() as u64;
        let outcome = supervisor.step(control, is_trusted(), now_ms);

        match outcome.effect {
            Some(Effect::SpawnTap) => spawn_listener(&app, &matcher, &control_tx),
            Some(Effect::StopTap) => request_tap_stop(),
            None => {}
        }
        set_capability(&app, &capability, outcome.phase);
        next_timeout = outcome.next_timeout;
    }
}
