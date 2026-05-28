use super::config::{should_preload, Engine as EngineKind, TranscriptionConfig, UnloadPolicy};
use super::error::TranscriptionError;
use super::events::{LocalModelState, ModelStateEvent, ModelStatus, UnloadReason, EVENT_CHANNEL};
use log::{debug, info, warn};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use transcribe_rs::onnx::moonshine::{MoonshineModel, MoonshineVariant};
use transcribe_rs::onnx::parakeet::{ParakeetModel, ParakeetParams, TimestampGranularity};
use transcribe_rs::onnx::Quantization;
use transcribe_rs::whisper_cpp::{WhisperEngine, WhisperInferenceParams};
use transcribe_rs::{SpeechModel, TranscribeOptions};

/// Resident engine variants. Dropping any variant releases the model
/// resources held by the inner type.
enum Engine {
    Whisper(WhisperEngine),
    Parakeet(ParakeetModel),
    Moonshine(MoonshineModel),
}

/// The (path, engine) pair is inseparable: engine X is always loaded from
/// path Y. One mutex slot holds both.
type Cached = Option<(PathBuf, Engine)>;

/// Owns the resident engine's lifecycle and the state observers see while it
/// runs. Cache + ambient config + policy + status snapshot + lifecycle event
/// emission all serve that one concern; they share the struct because they
/// share the lifecycle.
#[derive(Clone)]
pub struct ModelManager {
    /// The currently-resident engine and the path it was loaded from. The
    /// mutex is held across `load` and the user closure inside `with_engine`
    /// so concurrent transcribe calls serialize (one engine fits in memory).
    cached: Arc<Mutex<Cached>>,

    /// Millis since UNIX_EPOCH of the last transcription start or completion.
    /// Atomic so the idle watcher can read it without contending with the
    /// cache mutex during long inference.
    last_activity_ms: Arc<AtomicU64>,

    /// Ambient configuration pushed by the FE via `set_transcription_config`.
    /// Read by `transcribe()` to dispatch and by `snapshot()` to report
    /// `(engine, model_path)` without touching the cache mutex.
    config: Arc<RwLock<Option<TranscriptionConfig>>>,

    /// Cache-independent status field for `snapshot()`. Mutated by load,
    /// inference, and eviction paths; never held across a long operation.
    /// The cache mutex stays held across inference, but `status` does not,
    /// so snapshot never blocks behind a transcription.
    status: Arc<RwLock<ModelStatus>>,

    /// Logical identity token for the selected `(engine, model_path)`. Older
    /// operations may finish, but they must not publish state after a newer
    /// model selection.
    model_generation: Arc<AtomicU64>,

    /// Handle used for `Emitter::emit` on the lifecycle event channel.
    /// Constructed once in `setup` and cloned cheaply through `Clone` on
    /// the manager.
    app: AppHandle,
}

impl ModelManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            cached: Arc::new(Mutex::new(None)),
            last_activity_ms: Arc::new(AtomicU64::new(now_millis())),
            config: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(ModelStatus::Idle)),
            model_generation: Arc::new(AtomicU64::new(0)),
            app,
        }
    }

    // ── Ambient config ────────────────────────────────────────────────

    /// Push the FE-side configuration. If `(engine, model_path)` changed
    /// since the last push, the previous resident model is dropped (with a
    /// `ConfigChanged` unload event) and a background preload kicks off so
    /// the next transcription does not pay cold-start latency. Other field
    /// changes (language, prompt, policy) take effect on next transcription
    /// without a reload.
    pub fn set_transcription_config(&self, config: TranscriptionConfig) {
        let config = match self.constrain_config(config) {
            Ok(config) => config,
            Err(message) => {
                warn!("[Transcription] rejected local model config: {}", message);
                {
                    let mut guard = self.write_config();
                    *guard = None;
                }
                self.evict_with_reason(UnloadReason::ConfigChanged);
                self.set_status(ModelStatus::Error {
                    message: message.clone(),
                });
                self.emit(ModelStateEvent::LoadingFailed {
                    state: self.snapshot(),
                    error: message,
                });
                return;
            }
        };

        let (preload_generation, selection_state) = {
            let mut guard = self.write_config();
            let needs_preload = should_preload(guard.as_ref(), &config);
            let was_waiting_for_previous_model = !matches!(self.read_status(), ModelStatus::Idle);
            let generation =
                needs_preload.then(|| self.model_generation.fetch_add(1, Ordering::SeqCst) + 1);
            *guard = Some(config.clone());
            let selection_state = needs_preload.then(|| {
                let status = if was_waiting_for_previous_model {
                    ModelStatus::Switching
                } else {
                    ModelStatus::Idle
                };
                self.set_status(status.clone());
                state_for_config(&config, status)
            });
            (generation, selection_state)
        };

        // Always notify: SelectionChanged is the FE's signal to refresh model
        // identity displays even when the engine/path are the same.
        self.emit(ModelStateEvent::SelectionChanged {
            state: selection_state.unwrap_or_else(|| self.snapshot()),
        });

        let Some(generation) = preload_generation else {
            return;
        };

        // Hand off the eviction + preload to a background thread so this
        // command returns immediately. The eviction itself takes the cache
        // lock; if a transcribe is in-flight, the eviction waits for it
        // (correct: don't yank a model out from under an active inference).
        // The preload then loads the new model. The FE sees a sequence of
        // events on `transcription://model-state`: Unloaded(ConfigChanged)
        // → LoadingStarted → LoadingCompleted | LoadingFailed.
        let this = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if !this.is_current_model_generation(generation) {
                return;
            }
            this.evict_with_reason_if_current(UnloadReason::ConfigChanged, Some(generation));
            if let Err(err) = this.preload(config, generation) {
                warn!("[Transcription] preload failed: {}", err);
            }
        });
    }

    fn constrain_config(
        &self,
        mut config: TranscriptionConfig,
    ) -> Result<TranscriptionConfig, String> {
        config.model_path = self.app_model_path(&config.model_path)?;
        Ok(config)
    }

    fn app_model_path(&self, model_path: &str) -> Result<String, String> {
        let app_data_dir = self
            .app
            .path()
            .app_data_dir()
            .map_err(|e| format!("resolve app data directory: {}", e))?
            .canonicalize()
            .map_err(|e| format!("resolve app data directory: {}", e))?;
        let models_dir = app_data_dir.join("models");
        let path = PathBuf::from(model_path)
            .canonicalize()
            .map_err(|e| format!("resolve model path {}: {}", model_path, e))?;

        if !path.starts_with(&models_dir) {
            return Err(
                "Local model path must be inside the app data models directory".to_string(),
            );
        }

        Ok(path.to_string_lossy().to_string())
    }

    fn write_config(&self) -> std::sync::RwLockWriteGuard<'_, Option<TranscriptionConfig>> {
        self.config
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn read_config(&self) -> Option<TranscriptionConfig> {
        self.config
            .read()
            .map(|g| g.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
    }

    fn read_config_with_generation(&self) -> Option<(TranscriptionConfig, u64)> {
        let guard = self.read_config_guard();
        let config = guard.clone()?;
        let generation = self.model_generation.load(Ordering::SeqCst);
        Some((config, generation))
    }

    fn read_config_guard(&self) -> RwLockReadGuard<'_, Option<TranscriptionConfig>> {
        self.config
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn read_status(&self) -> ModelStatus {
        self.status
            .read()
            .map(|g| g.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
    }

    fn current_policy(&self) -> UnloadPolicy {
        self.read_config()
            .map(|c| c.unload_policy)
            .unwrap_or(UnloadPolicy::DEFAULT)
    }

    // ── Snapshot ──────────────────────────────────────────────────────

    /// Read-only view of `(engine, model_path, status)`. Does not touch the
    /// cache mutex, so it returns immediately even mid-inference. This is
    /// what new windows call on mount to catch up to current state without
    /// waiting for the next event.
    pub fn snapshot(&self) -> LocalModelState {
        let config = self.read_config();
        let status = self.read_status();
        LocalModelState {
            engine: config.as_ref().map(|c| c.engine),
            model_path: config.map(|c| c.model_path),
            status,
        }
    }

    fn set_status(&self, status: ModelStatus) {
        match self.status.write() {
            Ok(mut g) => *g = status,
            Err(poisoned) => *poisoned.into_inner() = status,
        }
    }

    // ── Transcribe ────────────────────────────────────────────────────

    /// Synchronous inference dispatch. Reads the ambient configuration,
    /// validates the samples, then routes to the engine-specific path.
    /// Called from a blocking-pool thread.
    pub fn transcribe(&self, samples: Vec<f32>) -> Result<String, TranscriptionError> {
        let Some((config, generation)) = self.read_config_with_generation() else {
            return Err(TranscriptionError::NoConfig {
                message:
                    "Transcription config not set. The frontend must call setTranscriptionConfig first."
                        .to_string(),
            });
        };

        if samples.is_empty() {
            warn!("[Transcription] zero samples, returning empty transcript");
            return Ok(String::new());
        }

        let samples = sanitize_samples(samples);

        info!(
            "[Transcription] starting {:?} transcription: pcm_samples={}",
            config.engine,
            samples.len(),
        );

        let model_path = PathBuf::from(&config.model_path);
        let transcript = match config.engine {
            EngineKind::Whispercpp => {
                let mut params = WhisperInferenceParams::default();
                params.language = config.language.clone();
                params.initial_prompt = config.initial_prompt.clone();
                params.print_special = false;
                params.print_progress = false;
                params.print_realtime = false;
                params.print_timestamps = false;
                params.suppress_blank = true;
                params.suppress_non_speech_tokens = true;
                params.no_speech_thold = 0.2;

                self.with_whisper(&config, generation, model_path, |engine| {
                    let result = engine
                        .transcribe_with(&samples, &params)
                        .map_err(transcription_err)?;
                    Ok(result.text.trim().to_string())
                })?
            }
            EngineKind::Parakeet => {
                let params = ParakeetParams {
                    timestamp_granularity: Some(TimestampGranularity::Segment),
                    ..Default::default()
                };
                self.with_parakeet(&config, generation, model_path, |engine| {
                    let result = engine
                        .transcribe_with(&samples, &params)
                        .map_err(transcription_err)?;
                    Ok(result.text.trim().to_string())
                })?
            }
            EngineKind::Moonshine => {
                let variant = parse_moonshine_variant(&config.model_path)?;
                self.with_moonshine(&config, generation, model_path, variant, |engine| {
                    let result = engine
                        .transcribe(&samples, &TranscribeOptions::default())
                        .map_err(transcription_err)?;
                    Ok(result.text.trim().to_string())
                })?
            }
        };

        info!(
            "[Transcription] {:?} transcription complete: characters={}",
            config.engine,
            transcript.len()
        );
        self.evict_if_immediate(config.unload_policy, generation);
        Ok(transcript)
    }

    // ── Preload ───────────────────────────────────────────────────────

    /// Load the configured model without running inference. Preload drives
    /// loading events only; inference events are reserved for real
    /// transcriptions.
    fn preload(
        &self,
        config: TranscriptionConfig,
        generation: u64,
    ) -> Result<(), TranscriptionError> {
        if !self.is_current_model_generation(generation) {
            return Ok(());
        }
        let model_path = PathBuf::from(&config.model_path);
        match config.engine {
            EngineKind::Whispercpp => {
                self.ensure_loaded(
                    &config,
                    model_path,
                    |e| matches!(e, Engine::Whisper(_)),
                    |path| {
                        WhisperEngine::load(path)
                            .map(Engine::Whisper)
                            .map_err(|e| format!("Failed to load Whisper model: {}", e))
                    },
                    LoadCaller::Preload { generation },
                )?;
            }
            EngineKind::Parakeet => {
                self.ensure_loaded(
                    &config,
                    model_path,
                    |e| matches!(e, Engine::Parakeet(_)),
                    |path| {
                        ParakeetModel::load(path, &Quantization::Int8)
                            .map(Engine::Parakeet)
                            .map_err(|e| format!("Failed to load Parakeet model: {}", e))
                    },
                    LoadCaller::Preload { generation },
                )?;
            }
            EngineKind::Moonshine => {
                let variant = parse_moonshine_variant(&config.model_path)?;
                self.ensure_loaded(
                    &config,
                    model_path,
                    |e| matches!(e, Engine::Moonshine(_)),
                    |path| {
                        MoonshineModel::load(path, variant, &Quantization::default())
                            .map(Engine::Moonshine)
                            .map_err(|e| format!("Failed to load Moonshine model: {}", e))
                    },
                    LoadCaller::Preload { generation },
                )?;
            }
        }
        Ok(())
    }

    // ── Engine cache + eviction ───────────────────────────────────────

    fn with_whisper<T>(
        &self,
        config: &TranscriptionConfig,
        generation: u64,
        model_path: PathBuf,
        f: impl FnOnce(&mut WhisperEngine) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        self.with_engine(
            config,
            model_path,
            |e| matches!(e, Engine::Whisper(_)),
            |path| {
                WhisperEngine::load(path)
                    .map(Engine::Whisper)
                    .map_err(|e| format!("Failed to load Whisper model: {}", e))
            },
            LoadCaller::Transcription { generation },
            |engine| match engine {
                Engine::Whisper(e) => f(e),
                _ => unreachable!("can_reuse guarantees Whisper variant"),
            },
        )
    }

    fn with_parakeet<T>(
        &self,
        config: &TranscriptionConfig,
        generation: u64,
        model_path: PathBuf,
        f: impl FnOnce(&mut ParakeetModel) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        self.with_engine(
            config,
            model_path,
            |e| matches!(e, Engine::Parakeet(_)),
            |path| {
                ParakeetModel::load(path, &Quantization::Int8)
                    .map(Engine::Parakeet)
                    .map_err(|e| format!("Failed to load Parakeet model: {}", e))
            },
            LoadCaller::Transcription { generation },
            |engine| match engine {
                Engine::Parakeet(e) => f(e),
                _ => unreachable!("can_reuse guarantees Parakeet variant"),
            },
        )
    }

    fn with_moonshine<T>(
        &self,
        config: &TranscriptionConfig,
        generation: u64,
        model_path: PathBuf,
        variant: MoonshineVariant,
        f: impl FnOnce(&mut MoonshineModel) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        self.with_engine(
            config,
            model_path,
            |e| matches!(e, Engine::Moonshine(_)),
            |path| {
                MoonshineModel::load(path, variant, &Quantization::default())
                    .map(Engine::Moonshine)
                    .map_err(|e| format!("Failed to load Moonshine model: {}", e))
            },
            LoadCaller::Transcription { generation },
            |engine| match engine {
                Engine::Moonshine(e) => f(e),
                _ => unreachable!("can_reuse guarantees Moonshine variant"),
            },
        )
    }

    /// Hold the cache lock across load. If `(path, engine kind)` matches the
    /// cache, reuse; otherwise drop and load fresh under the same lock.
    /// Stale background preloads drop their loaded engine instead of
    /// publishing or caching it; stale transcriptions keep their engine long
    /// enough to preserve transcript behavior, but stop publishing state.
    ///
    /// Holding the cache lock across `emit` is safe: Tauri's emit is sync
    /// and FE handlers run on the JS event loop, so no Rust caller can
    /// re-enter and contend on this mutex.
    fn ensure_loaded(
        &self,
        config: &TranscriptionConfig,
        model_path: PathBuf,
        can_reuse: impl Fn(&Engine) -> bool,
        load: impl FnOnce(&Path) -> Result<Engine, String>,
        caller: LoadCaller,
    ) -> Result<EnsureLoaded<'_>, TranscriptionError> {
        if caller.is_preload() && !self.is_current_model_generation(caller.generation()) {
            return Ok(EnsureLoaded::Stale);
        }

        let mut guard = lock_cached(&self.cached);

        if caller.is_preload() && !self.is_current_model_generation(caller.generation()) {
            return Ok(EnsureLoaded::Stale);
        }

        let reuse = matches!(&*guard, Some((p, e)) if p == &model_path && can_reuse(e));

        if !reuse {
            let _ = guard.take();
            let loading_started = self.publish_if_current(
                caller.generation(),
                config,
                ModelStatus::Loading,
                |state| ModelStateEvent::LoadingStarted { state },
            );
            if caller.is_preload() && loading_started.is_none() {
                return Ok(EnsureLoaded::Stale);
            }
            let started = Instant::now();
            match load(&model_path) {
                Ok(engine) => {
                    let elapsed_ms = started.elapsed().as_millis() as u64;
                    debug!(
                        "[Transcription] model loaded: {} ({}ms)",
                        model_path.display(),
                        elapsed_ms
                    );
                    if caller.is_preload() {
                        if !self.is_current_model_generation(caller.generation()) {
                            return Ok(EnsureLoaded::Stale);
                        }
                        *guard = Some((model_path, engine));
                        let Some(()) = self.publish_if_current(
                            caller.generation(),
                            config,
                            ModelStatus::Ready,
                            |state| ModelStateEvent::LoadingCompleted { state, elapsed_ms },
                        ) else {
                            let _ = guard.take();
                            return Ok(EnsureLoaded::Stale);
                        };
                    } else {
                        *guard = Some((model_path, engine));
                        let _ = self.publish_if_current(
                            caller.generation(),
                            config,
                            ModelStatus::Ready,
                            |state| ModelStateEvent::LoadingCompleted { state, elapsed_ms },
                        );
                    }
                }
                Err(message) => {
                    if caller.is_preload() && !self.is_current_model_generation(caller.generation())
                    {
                        return Ok(EnsureLoaded::Stale);
                    }
                    let _ = self.publish_if_current(
                        caller.generation(),
                        config,
                        ModelStatus::Error {
                            message: message.clone(),
                        },
                        |state| ModelStateEvent::LoadingFailed {
                            state,
                            error: message.clone(),
                        },
                    );
                    return Err(TranscriptionError::ModelLoadError { message });
                }
            }
        }

        Ok(EnsureLoaded::Loaded(guard))
    }

    /// Hold the cache lock across load and use. Preloading calls only
    /// `ensure_loaded`; real transcriptions additionally emit semantic
    /// inference events around the user closure.
    fn with_engine<T>(
        &self,
        config: &TranscriptionConfig,
        model_path: PathBuf,
        can_reuse: impl Fn(&Engine) -> bool,
        load: impl FnOnce(&Path) -> Result<Engine, String>,
        caller: LoadCaller,
        use_engine: impl FnOnce(&mut Engine) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        self.touch_activity();
        let mut guard = match self.ensure_loaded(config, model_path, can_reuse, load, caller)? {
            EnsureLoaded::Loaded(guard) => guard,
            EnsureLoaded::Stale => unreachable!("stale cache loads only abort preloads"),
        };

        let (_, engine) = guard.as_mut().expect("cache slot populated above");
        let _ = self.publish_if_current(
            caller.generation(),
            config,
            ModelStatus::Inferring,
            |state| ModelStateEvent::InferenceStarted { state },
        );
        let started = Instant::now();
        let result = use_engine(engine);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        self.touch_activity();
        match &result {
            Ok(_) => {
                let _ = self.publish_if_current(
                    caller.generation(),
                    config,
                    ModelStatus::Ready,
                    |state| ModelStateEvent::InferenceCompleted { state, elapsed_ms },
                );
            }
            Err(e) => {
                // Don't clear the cache on inference failure: the engine is
                // still loaded and the next call may succeed (transient FFI
                // or input issue). The status reflects the last result; a
                // successful next call flips it back to Ready.
                let message = e.to_string();
                let _ = self.publish_if_current(
                    caller.generation(),
                    config,
                    ModelStatus::Error {
                        message: message.clone(),
                    },
                    |state| ModelStateEvent::InferenceFailed {
                        state,
                        error: message,
                    },
                );
            }
        }
        result
    }

    fn touch_activity(&self) {
        self.last_activity_ms.store(now_millis(), Ordering::Relaxed);
    }

    /// Drop the resident model now if the current policy is `Immediately`.
    /// Called at the end of every successful transcription.
    fn evict_if_immediate(&self, policy: UnloadPolicy, generation: u64) {
        if matches!(policy, UnloadPolicy::Immediately) {
            self.evict_with_reason_if_current(UnloadReason::Immediate, Some(generation));
        }
    }

    /// Drop the resident model and emit an `Unloaded` event with the given
    /// reason. Idempotent: a no-op when the cache is already empty.
    fn evict_with_reason(&self, reason: UnloadReason) {
        self.evict_with_reason_if_current(reason, None);
    }

    fn evict_with_reason_if_current(&self, reason: UnloadReason, generation: Option<u64>) {
        let mut guard = lock_cached(&self.cached);
        let config_guard = self.read_config_guard();
        if generation.is_some_and(|generation| !self.is_current_model_generation(generation)) {
            return;
        }
        if let Some((path, _engine)) = guard.take() {
            debug!(
                "[Transcription] unloaded model ({:?}): {}",
                reason,
                path.display()
            );
            // Drop the guard before emitting so emit handlers cannot deadlock
            // on the cache lock (they should not lock it anyway, but defensive
            // ordering is cheap).
            drop(guard);
            let status = if matches!(reason, UnloadReason::ConfigChanged) {
                ModelStatus::Switching
            } else {
                ModelStatus::Idle
            };
            self.set_status(status.clone());
            let state = state_for_config_option(config_guard.as_ref(), status);
            self.emit(ModelStateEvent::Unloaded { state, reason });
        }
    }

    // ── Idle watcher ──────────────────────────────────────────────────

    /// Start the background idle watcher. Spawns one task on the Tauri
    /// async runtime; safe to call once at setup.
    pub fn start_idle_watcher(&self) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let tick = Duration::from_secs(10);
            loop {
                tokio::time::sleep(tick).await;
                this.tick_idle();
            }
        });
    }

    fn tick_idle(&self) {
        let Some(timeout) = idle_timeout_for(self.current_policy()) else {
            return;
        };
        let idle = Duration::from_millis(
            now_millis().saturating_sub(self.last_activity_ms.load(Ordering::Relaxed)),
        );
        if idle < timeout {
            return;
        }
        // try_lock so a long transcription in progress just postpones eviction
        // to the next tick instead of blocking the watcher.
        let Ok(mut guard) = self.cached.try_lock() else {
            return;
        };
        if let Some((path, _engine)) = guard.take() {
            let idle_secs = idle.as_secs();
            debug!(
                "[Transcription] unloaded model (idle {}s): {}",
                idle_secs,
                path.display()
            );
            drop(guard);
            self.set_status(ModelStatus::Idle);
            self.emit(ModelStateEvent::Unloaded {
                state: self.snapshot(),
                reason: UnloadReason::Idle { idle_secs },
            });
        }
    }

    // ── Event emission ────────────────────────────────────────────────

    fn emit(&self, event: ModelStateEvent) {
        if let Err(err) = self.app.emit(EVENT_CHANNEL, &event) {
            warn!("[Transcription] failed to emit model-state event: {}", err);
        }
    }

    fn is_current_model_generation(&self, generation: u64) -> bool {
        self.model_generation.load(Ordering::SeqCst) == generation
    }

    fn with_current_model_generation<T>(
        &self,
        generation: u64,
        f: impl FnOnce() -> T,
    ) -> Option<T> {
        // The read lock closes the check-then-publish gap against
        // set_transcription_config, whose write lock bumps the generation.
        let _guard = self.read_config_guard();
        self.is_current_model_generation(generation).then(f)
    }

    fn publish_if_current(
        &self,
        generation: u64,
        config: &TranscriptionConfig,
        status: ModelStatus,
        build_event: impl FnOnce(LocalModelState) -> ModelStateEvent,
    ) -> Option<()> {
        self.with_current_model_generation(generation, || {
            self.set_status(status.clone());
            self.emit(build_event(state_for_config(config, status)));
        })
    }
}

#[derive(Clone, Copy)]
enum LoadCaller {
    Preload { generation: u64 },
    Transcription { generation: u64 },
}

impl LoadCaller {
    fn generation(self) -> u64 {
        match self {
            LoadCaller::Preload { generation } | LoadCaller::Transcription { generation } => {
                generation
            }
        }
    }

    fn is_preload(self) -> bool {
        matches!(self, LoadCaller::Preload { .. })
    }
}

enum EnsureLoaded<'a> {
    Loaded(MutexGuard<'a, Cached>),
    Stale,
}

/// Replace NaN/Inf with 0.0 and cap length so a malformed sample buffer
/// never reaches whisper.cpp's FFI boundary (where a `GGML_ASSERT` would
/// abort the process and bypass any Rust-level recovery). Cheap insurance
/// against the most common abort class.
fn state_for_config(config: &TranscriptionConfig, status: ModelStatus) -> LocalModelState {
    state_for_config_option(Some(config), status)
}

fn state_for_config_option(
    config: Option<&TranscriptionConfig>,
    status: ModelStatus,
) -> LocalModelState {
    LocalModelState {
        engine: config.map(|config| config.engine),
        model_path: config.map(|config| config.model_path.clone()),
        status,
    }
}

fn sanitize_samples(mut samples: Vec<f32>) -> Vec<f32> {
    // Cap at one hour of mono 16kHz audio. Beyond this we don't run
    // inference reliably anyway and the FE imposes its own caps; this
    // is a backstop against integer overflow or pathological inputs.
    const MAX_SAMPLES: usize = 16_000 * 60 * 60;
    if samples.len() > MAX_SAMPLES {
        warn!(
            "[Transcription] truncating {} samples to MAX_SAMPLES ({})",
            samples.len(),
            MAX_SAMPLES
        );
        samples.truncate(MAX_SAMPLES);
    }
    for s in samples.iter_mut() {
        if !s.is_finite() {
            *s = 0.0;
        }
    }
    samples
}

fn parse_moonshine_variant(model_path: &str) -> Result<MoonshineVariant, TranscriptionError> {
    let stem = Path::new(model_path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| TranscriptionError::ConfigError {
            message: format!(
                "Moonshine model path has no terminal directory name: {}",
                model_path
            ),
        })?;
    // Naming convention: moonshine-{variant}-{lang}. Match on the variant
    // segment between the first and last hyphen-bounded fields.
    if stem.starts_with("moonshine-tiny-") || stem == "moonshine-tiny" {
        Ok(MoonshineVariant::Tiny)
    } else if stem.starts_with("moonshine-base-") || stem == "moonshine-base" {
        Ok(MoonshineVariant::Base)
    } else {
        Err(TranscriptionError::ConfigError {
            message: format!(
                "Moonshine model path must end with moonshine-{{tiny|base}}-{{lang}}: got {}",
                stem
            ),
        })
    }
}

fn transcription_err(e: impl std::fmt::Display) -> TranscriptionError {
    TranscriptionError::TranscriptionError {
        message: e.to_string(),
    }
}

fn idle_timeout_for(policy: UnloadPolicy) -> Option<Duration> {
    match policy {
        UnloadPolicy::Never | UnloadPolicy::Immediately => None,
        UnloadPolicy::AfterFiveMinutes => Some(Duration::from_secs(5 * 60)),
        UnloadPolicy::AfterThirtyMinutes => Some(Duration::from_secs(30 * 60)),
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Lock the cache slot, recovering from poisoning by clearing the cached
/// (path, engine) so the next caller reloads from scratch instead of reusing
/// corrupted state from a previous panic.
fn lock_cached(cached: &Mutex<Cached>) -> MutexGuard<'_, Cached> {
    cached.lock().unwrap_or_else(|poisoned| {
        warn!(
            "[Transcription] Cache mutex was poisoned from previous panic, clearing state to force reload..."
        );
        let mut recovered = poisoned.into_inner();
        *recovered = None;
        recovered
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_timeout_is_none_for_non_timed_policies() {
        assert!(idle_timeout_for(UnloadPolicy::Never).is_none());
        assert!(idle_timeout_for(UnloadPolicy::Immediately).is_none());
    }

    #[test]
    fn idle_timeout_matches_minutes() {
        assert_eq!(
            idle_timeout_for(UnloadPolicy::AfterFiveMinutes),
            Some(Duration::from_secs(300))
        );
        assert_eq!(
            idle_timeout_for(UnloadPolicy::AfterThirtyMinutes),
            Some(Duration::from_secs(1800))
        );
    }

    #[test]
    fn sanitize_replaces_nonfinite_samples() {
        let cleaned = sanitize_samples(vec![1.0, f32::NAN, f32::INFINITY, -0.5, f32::NEG_INFINITY]);
        assert_eq!(cleaned, vec![1.0, 0.0, 0.0, -0.5, 0.0]);
    }

    #[test]
    fn parse_moonshine_variant_handles_known_names() {
        assert!(matches!(
            parse_moonshine_variant("/models/moonshine-tiny-en").unwrap(),
            MoonshineVariant::Tiny
        ));
        assert!(matches!(
            parse_moonshine_variant("/models/moonshine-base-en").unwrap(),
            MoonshineVariant::Base
        ));
    }

    #[test]
    fn parse_moonshine_variant_rejects_unknown_names() {
        assert!(parse_moonshine_variant("/models/moonshine-large-en").is_err());
        assert!(parse_moonshine_variant("/models/whisper-tiny").is_err());
    }

    #[test]
    fn state_for_config_uses_captured_model_identity() {
        let config = TranscriptionConfig {
            engine: EngineKind::Parakeet,
            model_path: "/models/parakeet".to_string(),
            language: Some("en".to_string()),
            initial_prompt: None,
            unload_policy: UnloadPolicy::AfterFiveMinutes,
        };

        let state = state_for_config(&config, ModelStatus::Inferring);

        assert_eq!(state.engine, Some(EngineKind::Parakeet));
        assert_eq!(state.model_path, Some("/models/parakeet".to_string()));
        assert_eq!(state.status, ModelStatus::Inferring);
    }
}
