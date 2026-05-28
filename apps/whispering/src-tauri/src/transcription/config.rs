use serde::{Deserialize, Serialize};

/// Ambient configuration the frontend pushes once per change. The Rust side
/// reads this on every `transcribe_recording` call instead of receiving
/// a per-call payload. Drift in `(engine, model_path)` triggers a preload;
/// drift in other fields takes effect on the next transcription with no
/// reload.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionConfig {
    pub engine: Engine,
    pub model_path: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub initial_prompt: Option<String>,
    pub unload_policy: UnloadPolicy,
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
/// device setting; serde tags below match its wire format exactly so the
/// FE value pushes straight through.
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

/// True when the new config asks for a different resident model than the old
/// one. Identity is `(engine, model_path)` only: language/prompt/policy
/// changes never trigger a reload because they take effect on next inference.
pub fn should_preload(old: Option<&TranscriptionConfig>, new: &TranscriptionConfig) -> bool {
    match old {
        None => true,
        Some(prev) => prev.engine != new.engine || prev.model_path != new.model_path,
    }
}
