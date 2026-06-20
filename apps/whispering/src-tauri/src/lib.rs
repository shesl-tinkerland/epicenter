use log::{info, warn};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_aptabase::EventTracker;
use tauri_plugin_log::{Target, TargetKind};

pub mod audio;
use audio::encode_recording_for_upload;
pub mod recorder;
use recorder::commands::{
    cancel_recording, clear_recording_artifacts, close_recording_session,
    delete_recording_artifacts, enumerate_recording_devices, get_current_recording_id,
    init_recording_session, start_recording, stop_recording,
};
use recorder::recorder::Recorder;

pub mod transcription;
use transcription::{
    delete_model_entry, download_model, get_transcription_state, link_local_model,
    list_model_entries, prewarm_model, resolve_model_files, reveal_models_folder,
    set_unload_policy, transcribe_recording, ModelCache, ModelStateEvent,
};

pub mod command;
use command::{
    get_microphone_permission, open_accessibility_settings, request_accessibility_permission,
    request_microphone_permission,
};

pub mod download;
use download::{cancel_download, DownloadManager};

pub mod media;
use media::{pause_playback, resume_playback};

// Flag-gated (`WHISPERING_TIMING`) latency instrumentation for the desktop
// audio pipeline. The `timing_note!` macro it exports is used across the
// recorder, audio, and transcription modules.
pub mod timing;

// Desktop global keyboard trigger backend (rdev listener + binding matcher).
// Built in isolation in Wave 2; the FE registrar swap and listener start-up
// land in Wave 3. Desktop-only because rdev is a desktop-only dependency.
#[cfg(desktop)]
pub mod keyboard;

// The recording overlay is a non-activating NSPanel on macOS only; other
// platforms create the overlay window from the frontend.
#[cfg(target_os = "macos")]
pub mod overlay;

/// Specta-known commands: every app command except the one that returns a
/// raw `tauri::ipc::Response` (which is not `specta::Type`). The builder
/// owns BOTH the runtime handler for these commands (see `run`) and the
/// TypeScript binding export (see `export_types` test).
fn make_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            write_text,
            simulate_enter_keystroke,
            simulate_copy_keystroke,
            get_current_recording_id,
            enumerate_recording_devices,
            init_recording_session,
            close_recording_session,
            start_recording,
            stop_recording,
            cancel_recording,
            delete_recording_artifacts,
            clear_recording_artifacts,
            transcribe_recording,
            prewarm_model,
            open_accessibility_settings,
            request_accessibility_permission,
            get_microphone_permission,
            request_microphone_permission,
            set_unload_policy,
            get_transcription_state,
            link_local_model,
            list_model_entries,
            delete_model_entry,
            resolve_model_files,
            download_model,
            reveal_models_folder,
            cancel_download,
            pause_playback,
            resume_playback,
            keyboard::commands::set_keyboard_shortcuts,
            keyboard::commands::set_auto_paste_enabled,
            keyboard::commands::set_keyboard_capturing,
            keyboard::commands::get_dictation_capability,
        ])
        // The FE listens through the generated `events` object. `collect_events!`
        // owns each topic name and pulls in the payload types
        // (`ShortcutTriggerEvent` -> `TriggerState`; `ShortcutCaptureEvent` ->
        // `KeyBinding`); `set_keyboard_shortcuts` separately pulls in
        // `CommandBinding` / `Modifier` / `Key`. `run` must call
        // `mount_events` so `Event::emit` and the generated listeners resolve.
        .events(tauri_specta::collect_events![
            ModelStateEvent,
            keyboard::ShortcutTriggerEvent,
            keyboard::ShortcutCaptureEvent,
            keyboard::DictationCapabilityEvent,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Result)
}

#[cfg(test)]
mod export_bindings {
    #[test]
    fn export_types() {
        super::make_specta_builder()
            .export(
                specta_typescript::Typescript::default(),
                "../src/lib/tauri/bindings.gen.ts",
            )
            .expect("failed to export bindings");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[tokio::main]
pub async fn run() {
    // Set up panic hook to capture crash information before the app exits.
    // The previous hook is preserved so default panic reporting still occurs.
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        use std::backtrace::Backtrace;
        let payload = panic_info.payload();
        let location = panic_info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());
        let thread_name = std::thread::current()
            .name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "unnamed thread".to_string());

        let message = if let Some(s) = payload.downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic payload".to_string()
        };

        let backtrace = Backtrace::force_capture();

        eprintln!(
            "[panic] thread={} location={} message={}",
            thread_name, location, message
        );
        eprintln!("{}", backtrace);

        // Write crash log to temp directory (works on all platforms)
        {
            use std::fs::OpenOptions;
            use std::io::Write;
            let crash_log_path = std::env::temp_dir().join("whispering-crash.log");
            if let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&crash_log_path)
            {
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let _ = writeln!(
                    file,
                    "[{}] thread={} location={} message={}",
                    timestamp, thread_name, location, message
                );
                let _ = writeln!(file, "{}", backtrace);
                let _ = writeln!(file, "-----");
            }
        }

        previous_hook(panic_info);
    }));

    // ONNX Runtime accelerator for Parakeet and Moonshine. `OrtAccelerator::Auto`
    // picks the best provider that's compiled in (CoreML on macOS, CPU on Linux),
    // but it deliberately excludes DirectML because DirectML needs sequential ORT
    // session settings that would penalize other backends. So on Windows we
    // select DirectML explicitly to honor the compiled-in `ort-directml` feature.
    // transcribe-rs always appends CPU to the EP list, so a CoreML or DirectML
    // init failure degrades to CPU rather than failing the transcription. Set
    // `ORT_LOG_SEVERITY_LEVEL=0` to confirm which EP ORT actually selected.
    #[cfg(target_os = "windows")]
    transcribe_rs::accel::set_ort_accelerator(transcribe_rs::accel::OrtAccelerator::DirectMl);

    // On macOS, force the CPU execution provider for the ONNX engines
    // (Parakeet, Moonshine). The default `Auto` selects CoreML, but our models
    // are int8-quantized and CoreML cannot run the int8 ops (ConvInteger,
    // DynamicQuantizeLinear): it silently falls back to CPU for them anyway,
    // then adds Metal context setup plus partition-boundary copies on top.
    // Benchmarks on parakeet-tdt-0.6b-v3-int8 measured CPU at ~3.5 us/sample
    // versus ~12 us/sample warm on CoreML (about 3x faster), and CPU also
    // silences the macOS "Context leak detected" GPU log spam. Prefer an fp16
    // model if you ever want genuine CoreML or Neural Engine acceleration.
    #[cfg(target_os = "macos")]
    transcribe_rs::accel::set_ort_accelerator(transcribe_rs::accel::OrtAccelerator::CpuOnly);

    let log_plugin = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .level_for("whispering::transcription", log::LevelFilter::Debug)
        .target(Target::new(TargetKind::Stdout))
        .target(Target::new(TargetKind::LogDir {
            file_name: Some("whispering".to_string()),
        }))
        .build();

    let mut builder = tauri::Builder::default().plugin(log_plugin);

    // Try to get APTABASE_KEY from environment, use empty string if not found
    let aptabase_key = option_env!("APTABASE_KEY").unwrap_or("");

    // Only add Aptabase plugin if key is not empty
    if !aptabase_key.is_empty() {
        info!("Aptabase analytics enabled");
        builder = builder.plugin(tauri_plugin_aptabase::Builder::new(aptabase_key).build());
    } else {
        warn!("APTABASE_KEY not found, analytics disabled");
    }

    // Compose two command handlers by name. The specta builder owns every
    // command in its `collect_commands!` list and is the source of truth for
    // TS bindings. `encode_recording_for_upload` (raw `tauri::ipc::Response`
    // return) is outside specta's reach, so it gets its own `generate_handler!`.
    // We route by name because `Invoke` is not Clone: each invocation can only
    // be consumed by one handler. The builder also owns the typed events; it is
    // moved into `setup` so `mount_events` can register their topics.
    let specta_builder = make_specta_builder();
    let specta_handler = tauri_specta::Builder::invoke_handler(&specta_builder);
    let raw_handler = tauri::generate_handler![encode_recording_for_upload]
        as fn(tauri::ipc::Invoke<tauri::Wry>) -> bool;

    builder = builder
        .plugin(tauri_plugin_macos_permissions::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(Recorder::new()))
        // Registry of in-flight model downloads; `cancel_download` aborts them.
        .manage(DownloadManager::default())
        .setup(move |app| {
            // Register the tauri-specta event topics so `Event::emit` (Rust) and
            // the generated `events` listeners (FE) resolve the same names.
            specta_builder.mount_events(app);

            // ModelCache owns an `AppHandle` for emitting model lifecycle
            // events, so it cannot be constructed at builder-time (no app handle
            // exists yet). Move construction into setup; everything that needs it
            // reads via `app.state::<ModelCache>()`.
            let cache = ModelCache::new(app.handle().clone());
            cache.start_idle_watcher();
            app.manage(cache);

            // Desktop global keyboard trigger backend. Constructing it spawns a
            // supervisor that owns the tap's whole lifecycle: it gates spawning
            // on the live macOS Accessibility trust, restarts a tap that dies
            // under a held grant, and publishes the `DictationCapability` the FE
            // views. There is no FE-driven start: trust is a fact about the
            // process that holds the tap, so the tap holder owns it.
            #[cfg(desktop)]
            app.manage(keyboard::TapController::new(app.handle().clone()));

            // Create the recording overlay as a non-activating NSPanel up front
            // (hidden); the frontend shows it when recording starts.
            #[cfg(target_os = "macos")]
            overlay::create_recording_overlay(app.handle());

            Ok(())
        });

    // tauri-nspanel backs the macOS recording overlay panel.
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                let _ = app
                    .get_webview_window("main")
                    .expect("no main window")
                    .set_focus();
            }));
    }

    let builder = builder.invoke_handler(move |invoke| {
        if invoke.message.command() == "encode_recording_for_upload" {
            raw_handler(invoke)
        } else {
            specta_handler(invoke)
        }
    });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handler, event| {
        // Only track events if Aptabase is enabled (key is not empty)
        if !aptabase_key.is_empty() {
            match event {
                tauri::RunEvent::Exit { .. } => {
                    let _ = handler.track_event("app_exited", None);
                    handler.flush_events_blocking();
                }
                tauri::RunEvent::Ready { .. } => {
                    let _ = handler.track_event("app_started", None);
                }
                _ => {}
            }
        }
    });
}

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Where `write_text` left the transcript.
///
/// - `Pasted`: a synthetic paste landed it at the cursor and the user's original
///   clipboard was restored.
/// - `LeftOnClipboard`: delivery could not paste (no Accessibility grant, or the
///   paste itself failed), so the transcript was left on the clipboard as the
///   fallback — always one ⌘V away.
///
/// The frontend maps this to the dictation pill's delivery reach.
#[derive(Clone, Copy, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum WriteTextOutcome {
    Pasted,
    LeftOnClipboard,
}

/// Wait after writing the transcript to the clipboard before posting ⌘V. The
/// clipboard write is synchronous (the plugin blocks on the OS pasteboard), so
/// this is not "waiting for the clipboard" — it gives the freshly built event tap
/// a beat to come up before the keystroke is posted.
const PRE_PASTE_SETTLE: std::time::Duration = std::time::Duration::from_millis(50);

/// Wait after posting ⌘V before restoring the user's original clipboard. enigo
/// exposes no paste-completion signal (`CGEventPost` returns nothing), so this is
/// the window the target app has to consume the paste before the old clipboard
/// goes back. Restore too early and a slow app pastes the original content
/// instead of the transcript. Espanso's equivalent default is 300ms; ours is
/// 100ms (mirrored by `COPY_SETTLE_MS` in selection.ts — keep them in step).
const PRE_RESTORE_SETTLE: std::time::Duration = std::time::Duration::from_millis(100);

/// Delivers text to the cursor, falling back to the clipboard when it cannot.
///
/// The reach is decided from the live Accessibility *capability* before the
/// keystroke, not from the keystroke's result. A `Broken` grant — one that still
/// reads as trusted via `AXIsProcessTrusted` but whose synthetic events the OS
/// drops — lets the paste return `Ok` while nothing lands, so observing the
/// result is unreliable. When we can paste, the clipboard sandwich (save → write
/// → paste → restore) preserves the user's clipboard; when we cannot, the
/// transcript is left on the clipboard as the fallback. The transcript is
/// independently saved to history either way, so this is a reduced reach, never
/// data loss.
#[tauri::command]
#[specta::specta]
async fn write_text(app: tauri::AppHandle, text: String) -> Result<WriteTextOutcome, String> {
    // Can a synthetic ⌘V actually land right now? On macOS, gate on the
    // supervisor's capability, not a bare `AXIsProcessTrusted`. The supervisor
    // folds the tap's liveness into the value, so `Active` alone is paste-capable.
    // `Broken` is a stale post-update grant that still reads as trusted — so
    // `is_trusted()`, and enigo's own `Enigo::new` permission check (which calls
    // the same API), would both wave it through — but whose ⌘V the OS silently
    // drops while `enigo` still returns `Ok`. The old `is_trusted()` gate took
    // that path: it reported `Pasted` and restored the clipboard over the
    // transcript, a silent loss. Refuse it here. Every other desktop has no
    // Accessibility gate, so they paste unconditionally.
    #[cfg(target_os = "macos")]
    let can_paste = {
        use crate::keyboard::{DictationCapability, TapController};
        app.state::<TapController>().capability() == DictationCapability::Active
    };
    #[cfg(not(target_os = "macos"))]
    let can_paste = true;

    if !can_paste {
        app.clipboard()
            .write_text(&text)
            .map_err(|e| format!("Failed to write to clipboard: {}", e))?;
        return Ok(WriteTextOutcome::LeftOnClipboard);
    }

    // Clipboard sandwich: borrow the clipboard to carry the paste, restore it only
    // once the paste has provably landed.
    let original_clipboard = app.clipboard().read_text().ok();

    app.clipboard()
        .write_text(&text)
        .map_err(|e| format!("Failed to write to clipboard: {}", e))?;

    // Let the event tap settle before posting the keystroke (see PRE_PASTE_SETTLE).
    tokio::time::sleep(PRE_PASTE_SETTLE).await;

    // Simulate paste using virtual key codes (layout-independent). Issue every
    // press/release even on a mid-sequence error so a failure can never leave the
    // modifier stuck down.
    let paste_result = (|| -> Result<(), String> {
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        let (modifier, v_key) = (Key::Meta, Key::Other(9)); // Virtual key code for V on macOS
        #[cfg(target_os = "windows")]
        let (modifier, v_key) = (Key::Control, Key::Other(0x56)); // VK_V on Windows
        #[cfg(target_os = "linux")]
        let (modifier, v_key) = (Key::Control, Key::Unicode('v')); // Fallback for Linux

        let press_modifier = enigo.key(modifier, Direction::Press);
        let press_v = enigo.key(v_key, Direction::Press);
        let release_v = enigo.key(v_key, Direction::Release);
        let release_modifier = enigo.key(modifier, Direction::Release);
        press_modifier
            .and(press_v)
            .and(release_v)
            .and(release_modifier)
            .map_err(|e| format!("Failed to simulate paste: {}", e))
    })();

    if paste_result.is_err() {
        // Trusted but the paste still failed (rare). The transcript is already on
        // the clipboard from above; keep it there rather than restoring it away.
        return Ok(WriteTextOutcome::LeftOnClipboard);
    }

    // Give the target app the paste-consume window before restoring the clipboard
    // (see PRE_RESTORE_SETTLE).
    tokio::time::sleep(PRE_RESTORE_SETTLE).await;

    // Restore the user's original clipboard now that the paste has landed.
    if let Some(content) = original_clipboard {
        app.clipboard()
            .write_text(&content)
            .map_err(|e| format!("Failed to restore clipboard: {}", e))?;
    }

    Ok(WriteTextOutcome::Pasted)
}

/// Simulates pressing the Enter/Return key
///
/// This is useful for automatically submitting text in chat applications
/// after transcription has been pasted.
#[tauri::command]
#[specta::specta]
async fn simulate_enter_keystroke() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    // Use Direction::Click for a combined press+release action
    enigo
        .key(Key::Return, Direction::Click)
        .map_err(|e| format!("Failed to simulate Enter key: {}", e))?;

    Ok(())
}

/// Simulates pressing the copy shortcut (Cmd+C on macOS, Ctrl+C elsewhere)
///
/// This copies the active selection in the foreground app to the clipboard. The
/// frontend pairs it with a clipboard save/read/restore to capture the user's
/// selection without clobbering their clipboard (see the text service's
/// `captureSelection`).
#[tauri::command]
#[specta::specta]
async fn simulate_copy_keystroke() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    // Use virtual key codes for C to work with any keyboard layout, matching the
    // V codes in `write_text`.
    #[cfg(target_os = "macos")]
    let (modifier, c_key) = (Key::Meta, Key::Other(8)); // Virtual key code for C on macOS
    #[cfg(target_os = "windows")]
    let (modifier, c_key) = (Key::Control, Key::Other(0x43)); // VK_C on Windows
    #[cfg(target_os = "linux")]
    let (modifier, c_key) = (Key::Control, Key::Unicode('c')); // Fallback for Linux

    // Press modifier + C
    enigo
        .key(modifier, Direction::Press)
        .map_err(|e| format!("Failed to press modifier key: {}", e))?;
    enigo
        .key(c_key, Direction::Press)
        .map_err(|e| format!("Failed to press C key: {}", e))?;

    // Release C + modifier (in reverse order for proper cleanup)
    enigo
        .key(c_key, Direction::Release)
        .map_err(|e| format!("Failed to release C key: {}", e))?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| format!("Failed to release modifier key: {}", e))?;

    Ok(())
}
