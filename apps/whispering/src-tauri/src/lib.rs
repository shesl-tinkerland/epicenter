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
    get_transcription_state, set_transcription_config, transcribe_recording, ModelManager,
    ModelStateEvent,
};

pub mod command;
use command::open_accessibility_settings;

pub mod markdown;
use markdown::write_markdown_files;

/// Specta-known commands: every app command except the one that returns a
/// raw `tauri::ipc::Response` (which is not `specta::Type`). The builder
/// owns BOTH the runtime handler for these commands (see `run`) and the
/// TypeScript binding export (see `export_types` test).
fn make_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            write_text,
            simulate_enter_keystroke,
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
            open_accessibility_settings,
            write_markdown_files,
            set_transcription_config,
            get_transcription_state,
        ])
        // The FE listens on this channel manually; only the payload type
        // needs to be exported for `listen<ModelStateEvent>(...)`.
        .typ::<ModelStateEvent>()
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
        .setup(|app| {
            // ModelManager owns an `AppHandle` for emitting lifecycle events
            // on the `transcription://model-state` channel, so it cannot be
            // constructed at builder-time (no app handle exists yet). Move
            // construction into setup; everything that needs it reads via
            // `app.state::<ModelManager>()`.
            let manager = ModelManager::new(app.handle().clone());
            manager.start_idle_watcher();
            app.manage(manager);
            Ok(())
        });

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

    // Compose two handlers by command name. The specta builder owns every
    // command in its `collect_commands!` list and is the source of truth for
    // TS bindings. `encode_recording_for_upload` (raw `tauri::ipc::Response`
    // return) is outside specta's reach, so it gets its own
    // `generate_handler!`. We route by name because `Invoke` is not Clone:
    // each invocation can only be consumed by one handler.
    let specta_builder = make_specta_builder();
    let specta_handler = tauri_specta::Builder::invoke_handler(&specta_builder);
    let raw_handler = tauri::generate_handler![encode_recording_for_upload]
        as fn(tauri::ipc::Invoke<tauri::Wry>) -> bool;
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

/// Writes text at the cursor position using the clipboard sandwich technique
///
/// This method preserves the user's existing clipboard content by:
/// 1. Saving the current clipboard content
/// 2. Writing the new text to clipboard
/// 3. Simulating a paste operation (Cmd+V on macOS, Ctrl+V elsewhere)
/// 4. Restoring the original clipboard content
///
/// This approach is faster than typing character-by-character and preserves
/// the user's clipboard, making it ideal for inserting transcribed text.
#[tauri::command]
#[specta::specta]
async fn write_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    // 1. Save current clipboard content
    let original_clipboard = app.clipboard().read_text().ok();

    // 2. Write new text to clipboard
    app.clipboard()
        .write_text(&text)
        .map_err(|e| format!("Failed to write to clipboard: {}", e))?;

    // Small delay to ensure clipboard is updated
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // 3. Simulate paste operation using virtual key codes (layout-independent)
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    // Use virtual key codes for V to work with any keyboard layout
    #[cfg(target_os = "macos")]
    let (modifier, v_key) = (Key::Meta, Key::Other(9)); // Virtual key code for V on macOS
    #[cfg(target_os = "windows")]
    let (modifier, v_key) = (Key::Control, Key::Other(0x56)); // VK_V on Windows
    #[cfg(target_os = "linux")]
    let (modifier, v_key) = (Key::Control, Key::Unicode('v')); // Fallback for Linux

    // Press modifier + V
    enigo
        .key(modifier, Direction::Press)
        .map_err(|e| format!("Failed to press modifier key: {}", e))?;
    enigo
        .key(v_key, Direction::Press)
        .map_err(|e| format!("Failed to press V key: {}", e))?;

    // Release V + modifier (in reverse order for proper cleanup)
    enigo
        .key(v_key, Direction::Release)
        .map_err(|e| format!("Failed to release V key: {}", e))?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| format!("Failed to release modifier key: {}", e))?;

    // Small delay to ensure paste completes
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    // 4. Restore original clipboard content
    if let Some(content) = original_clipboard {
        app.clipboard()
            .write_text(&content)
            .map_err(|e| format!("Failed to restore clipboard: {}", e))?;
    }

    Ok(())
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
