use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug, Serialize, Deserialize, specta::Type)]
#[serde(tag = "name")]
pub enum TranscriptionError {
    #[error("Audio read error: {message}")]
    AudioReadError { message: String },

    #[error("GPU error: {message}")]
    GpuError { message: String },

    #[error("Model load error: {message}")]
    ModelLoadError { message: String },

    #[error("Transcription error: {message}")]
    TranscriptionError { message: String },

    /// The per-call spec holds a value that cannot be dispatched (e.g. a
    /// Moonshine model path that does not match `moonshine-{variant}-{lang}`).
    #[error("Transcription config error: {message}")]
    ConfigError { message: String },
}
