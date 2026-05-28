use super::config::Engine;
use serde::{Deserialize, Serialize};

/// Channel name for every model lifecycle event. The Rust emitter and the FE
/// `listen<ModelStateEvent>(...)` call both key off this symbol.
pub const EVENT_CHANNEL: &str = "transcription://model-state";

/// Snapshot of everything observable about the resident model. Every event
/// carries a full snapshot rather than a delta because `AppHandle::emit`
/// does not replay to future windows: a window opened mid-load reads the
/// current snapshot via `get_transcription_state` and then catches up via
/// the next event.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelState {
    pub engine: Option<Engine>,
    pub model_path: Option<String>,
    pub status: ModelStatus,
}

/// Lifecycle state of the resident model. Owned by an `Arc<RwLock<...>>`
/// inside `ModelManager` so `snapshot()` can read it without touching the
/// cache mutex (which is held across long-running inference).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelStatus {
    /// No model resident and none loading. Initial state, and reached after
    /// `Unloaded`.
    Idle,
    /// A different model is selected, but the manager is still draining the
    /// previous resident model before the new model can start loading.
    Switching,
    /// `with_engine` is currently inside the `load(&model_path)` call.
    Loading,
    /// A model is resident and not currently in use.
    Ready,
    /// `with_engine` is currently inside the user closure (transcribe call).
    /// The cache lock is held; `snapshot()` reports this without contending.
    Inferring,
    /// The last attempt to load or transcribe failed. Inference failures may
    /// leave the engine resident so a later transcription can reuse it.
    Error { message: String },
}

/// Reason the resident model was dropped. Folded into a single event variant
/// (`ModelStateEvent::Unloaded`) rather than fanned out into per-reason
/// variants so the FE has one branch to handle.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum UnloadReason {
    /// Synchronous eviction after a transcription completed under the
    /// `Immediately` unload policy.
    Immediate,
    /// Background idle watcher dropped the model after the configured timeout
    /// elapsed without activity.
    Idle {
        #[specta(type = u32)]
        idle_secs: u64,
    },
    /// User selected a different model in settings; the old one was dropped
    /// before the new one preloads.
    ConfigChanged,
}

/// Single event type for everything observable about the model lifecycle.
/// `tag = "kind"` matches `ModelStatus` and `UnloadReason` so the FE pattern
/// is uniform: `switch (event.kind)`.
///
/// `lib.rs` exports this payload type directly because the FE listens on
/// `EVENT_CHANNEL` manually.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ModelStateEvent {
    LoadingStarted {
        state: LocalModelState,
    },
    LoadingCompleted {
        state: LocalModelState,
        #[specta(type = u32)]
        elapsed_ms: u64,
    },
    LoadingFailed {
        state: LocalModelState,
        error: String,
    },
    InferenceStarted {
        state: LocalModelState,
    },
    InferenceCompleted {
        state: LocalModelState,
        #[specta(type = u32)]
        elapsed_ms: u64,
    },
    InferenceFailed {
        state: LocalModelState,
        error: String,
    },
    Unloaded {
        state: LocalModelState,
        reason: UnloadReason,
    },
    SelectionChanged {
        state: LocalModelState,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn event_wire_shape_uses_snake_case_kinds_and_camel_case_fields() {
        let event = ModelStateEvent::InferenceCompleted {
            state: LocalModelState {
                engine: Some(Engine::Whispercpp),
                model_path: Some("/models/whisper".to_string()),
                status: ModelStatus::Ready,
            },
            elapsed_ms: 123,
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({
                "kind": "inference_completed",
                "state": {
                    "engine": "whispercpp",
                    "modelPath": "/models/whisper",
                    "status": { "kind": "ready" }
                },
                "elapsedMs": 123
            })
        );
    }

    #[test]
    fn unload_reason_wire_shape_keeps_reason_fields_camel_case() {
        assert_eq!(
            serde_json::to_value(UnloadReason::Idle { idle_secs: 30 }).unwrap(),
            json!({
                "kind": "idle",
                "idleSecs": 30
            })
        );
    }

    #[test]
    fn switching_status_has_a_stable_wire_tag() {
        assert_eq!(
            serde_json::to_value(ModelStatus::Switching).unwrap(),
            json!({ "kind": "switching" })
        );
    }
}
