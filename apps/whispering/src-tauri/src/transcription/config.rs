use serde::{Deserialize, Serialize};

/// Per-call transcription inputs owned by the frontend. The Rust side receives
/// this with `transcribe_recording`, resolves the model at point of use, and
/// keeps only the resident model cache.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSpec {
    pub engine: Engine,
    /// Entry name inside the engine's models directory (a single file or
    /// directory name, never a path). `ModelCache` resolves it under
    /// `{app_data}/models/{engine}/` at load time, so a path never exists
    /// as data anywhere in the system.
    pub model_name: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub initial_prompt: Option<String>,
}

/// Local transcription engine. Wire tags match the frontend
/// `transcription.service` enum (`whispercpp` / `parakeet` / `moonshine`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    #[serde(rename = "whispercpp")]
    Whispercpp,
    Parakeet,
    Moonshine,
}

/// How long after the last transcription the resident model should be
/// dropped. Mirrors the frontend `transcription.localModelUnloadPolicy`
/// device setting; serde tags below match its wire format exactly.
///
/// `Immediately` is enforced synchronously at the end of each transcription;
/// timed variants are enforced by the background idle watcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UnloadPolicy {
    Never,
    Immediately,
    #[serde(rename = "after_5_minutes")]
    AfterFiveMinutes,
    #[serde(rename = "after_30_minutes")]
    AfterThirtyMinutes,
}

impl UnloadPolicy {
    pub const DEFAULT: Self = Self::AfterFiveMinutes;
}
