mod config;
mod error;
mod events;
mod model_cache;

use crate::recorder::read_artifact_samples;
pub use config::{TranscriptionSpec, UnloadPolicy};
pub use error::TranscriptionError;
pub use events::{LocalModelState, ModelStateEvent};
pub use model_cache::ModelCache;
use tauri::{AppHandle, State};

/// Reconcile the current local-model unload policy into the native idle
/// watcher. The frontend owns the value; Rust owns the clock.
#[tauri::command]
#[specta::specta]
pub fn set_unload_policy(policy: UnloadPolicy, model_cache: State<'_, ModelCache>) {
    model_cache.set_unload_policy(policy);
}

/// Snapshot the current model state. Used by late-mounted observers (a
/// second window, the settings panel re-opening, etc.) to catch up to
/// the current lifecycle state without waiting for the next event on
/// `transcription://model-state`.
///
/// Reads the status plus resident model identity, if any.
#[tauri::command]
#[specta::specta]
pub fn get_transcription_state(model_cache: State<'_, ModelCache>) -> LocalModelState {
    model_cache.snapshot()
}

/// Canonical transcribe-by-id path. Resolves the audio file under
/// `<appDataDir>/recordings/{recordingId}.*` (cpal-written WAV,
/// navigator-saved webm/opus/mp4, etc.), decodes, then runs inference using
/// the per-call transcription spec supplied by the frontend.
#[tauri::command]
#[specta::specta]
pub async fn transcribe_recording(
    recording_id: String,
    spec: TranscriptionSpec,
    app_handle: AppHandle,
    model_cache: State<'_, ModelCache>,
) -> Result<String, TranscriptionError> {
    let samples = read_artifact_samples(&app_handle, &recording_id)
        .map_err(|e| TranscriptionError::AudioReadError { message: e })?;

    let manager = model_cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.transcribe(samples, spec))
        .await
        .map_err(join_err)?
}

/// Map a join failure from spawn_blocking into a TranscriptionError so the
/// frontend always sees a structured error even when the background task
/// panics or is cancelled.
fn join_err(e: tauri::Error) -> TranscriptionError {
    TranscriptionError::TranscriptionError {
        message: format!("Background transcription task failed: {}", e),
    }
}
