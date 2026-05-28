//! CPAL recorder built around a two-thread pipeline.
//!
//! ```text
//! cpal callback thread          consumer worker thread
//! ┌────────────────────┐  mpsc  ┌─────────────────────┐
//! │ build_input_stream │ ─────▶ │ run_consumer        │
//! │  - downmix to mono │ chunks │  - accumulate Vec   │
//! │  - sample_tx.send  │        │  - resample (final) │
//! └────────────────────┘        │  - pad short clips  │
//!                               │  - emit artifact    │
//!                               └─────────────────────┘
//! ```
//!
//! The cpal callback never blocks: it downmixes to mono and ships
//! samples through an mpsc channel. The consumer worker accumulates,
//! resamples to 16 kHz at finalize, pads sub-1s clips, and hands the
//! resulting `Vec<f32>` (mono 16 kHz PCM) back to the command layer,
//! which writes the durable WAV artifact and emits the small handle JS
//! sees over IPC.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream};
use log::{debug, error, info};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::audio::resample_mono;

/// Simple result type using String for errors. Errors cross the IPC
/// boundary as plain strings so the JS side renders them in toasts.
pub type Result<T> = std::result::Result<T, String>;

/// Target rate for every recording. All local transcription engines
/// (whispercpp, parakeet, moonshine) want 16 kHz mono; the cloud
/// services accept opus encoded from 48 kHz which we get to via a
/// second resample step inside `audio::encode_pcm_to_opus_ogg`.
const TARGET_RATE: u32 = 16_000;

/// Sub-1s recordings are padded to this many samples (at 16 kHz, so
/// 1.25 s). Suppresses Whisper hallucination on near-silent short
/// clips. Empty recordings (no samples ever delivered) are left empty.
const SHORT_RECORDING_PAD_SAMPLES: usize = 20_000;

/// Worker-thread command channel.
#[derive(Debug)]
enum RecorderCmd {
    Start(mpsc::Sender<()>),
    Stop(mpsc::Sender<Result<Vec<f32>>>),
    Cancel(mpsc::Sender<Result<()>>),
    Shutdown,
}

/// CPAL-backed audio recorder. Owns the consumer worker, the command
/// channel, and the cpal stream's join handle for the active session.
pub struct Recorder {
    cmd_tx: Option<mpsc::Sender<RecorderCmd>>,
    worker_handle: Option<JoinHandle<()>>,
    is_recording: Arc<AtomicBool>,
    /// Id passed in at `init_session`. Surfaced by `get_current_recording_id`
    /// so a reloaded webview can reattach to the still-live Rust session.
    current_recording_id: Option<String>,
}

impl Recorder {
    pub fn new() -> Self {
        Self {
            cmd_tx: None,
            worker_handle: None,
            is_recording: Arc::new(AtomicBool::new(false)),
            current_recording_id: None,
        }
    }

    /// List available recording devices by name.
    pub fn enumerate_devices(&self) -> Result<Vec<String>> {
        let host = cpal::default_host();
        let devices = host
            .input_devices()
            .map_err(|e| format!("Failed to get input devices: {e}"))?
            .filter_map(|device| device.name().ok())
            .collect();

        Ok(devices)
    }

    /// Initialize a recording session and spawn the consumer worker.
    ///
    /// The cpal stream comes up immediately (mic permission prompt fires
    /// here, not on first `start_recording`). The consumer worker
    /// starts in an idle, drop-samples state until `start_recording`
    /// flips its internal recording flag.
    pub fn init_session(
        &mut self,
        device_name: String,
        recording_id: String,
        preferred_sample_rate: Option<u32>,
    ) -> Result<()> {
        // Clean up any existing session before standing up a new one.
        self.close_session()?;

        let host = cpal::default_host();
        let device = find_device(&host, &device_name)?;
        let config = get_optimal_config(&device, preferred_sample_rate)?;
        let sample_format = config.sample_format();
        let device_rate = config.sample_rate().0;
        let device_channels = config.channels();

        let stream_config = cpal::StreamConfig {
            channels: device_channels,
            sample_rate: cpal::SampleRate(device_rate),
            buffer_size: cpal::BufferSize::Default,
        };

        // Fresh atomic each session so a stale clone from the previous
        // worker can never flip a new stream's gate.
        self.is_recording = Arc::new(AtomicBool::new(false));
        let is_recording = self.is_recording.clone();

        let (sample_tx, sample_rx) = mpsc::channel::<Vec<f32>>();
        let (cmd_tx, cmd_rx) = mpsc::channel::<RecorderCmd>();

        let worker_handle = thread::spawn(move || {
            // The stream is built inside the worker thread because macOS
            // requires the cpal stream and the run-loop driving it to
            // share a thread.
            let stream = match build_input_stream(
                &device,
                &stream_config,
                sample_format,
                device_channels,
                sample_tx,
            ) {
                Ok(s) => s,
                Err(e) => {
                    error!("Failed to build stream: {e}");
                    return;
                }
            };

            if let Err(e) = stream.play() {
                error!("Failed to start stream: {e}");
                return;
            }

            info!("Audio stream started successfully");
            run_consumer(sample_rx, cmd_rx, device_rate, is_recording);
            drop(stream);
        });

        self.cmd_tx = Some(cmd_tx);
        self.worker_handle = Some(worker_handle);
        self.current_recording_id = Some(recording_id);

        info!(
            "Recording session initialized: {} Hz, {} channels",
            device_rate, device_channels,
        );

        Ok(())
    }

    /// Start recording and wait for the worker to acknowledge.
    pub fn start_recording(&mut self) -> Result<()> {
        let tx = self
            .cmd_tx
            .as_ref()
            .ok_or_else(|| "No recording session initialized".to_string())?;
        let (reply_tx, reply_rx) = mpsc::channel();
        tx.send(RecorderCmd::Start(reply_tx))
            .map_err(|e| format!("Failed to send start command: {e}"))?;
        reply_rx
            .recv()
            .map_err(|e| format!("Failed to receive start confirmation: {e}"))?;
        Ok(())
    }

    /// Stop recording and consume the worker's mono 16 kHz PCM.
    pub fn stop_recording(&mut self) -> Result<Vec<f32>> {
        let tx = self
            .cmd_tx
            .as_ref()
            .ok_or_else(|| "No recording session initialized".to_string())?;
        let (reply_tx, reply_rx) = mpsc::channel();
        tx.send(RecorderCmd::Stop(reply_tx))
            .map_err(|e| format!("Failed to send stop command: {e}"))?;
        reply_rx
            .recv()
            .map_err(|e| format!("Worker dropped stop reply: {e}"))?
    }

    /// Cancel the active recording, discarding any in-flight samples.
    pub fn cancel_recording(&mut self) -> Result<()> {
        if let Some(tx) = &self.cmd_tx {
            let (reply_tx, reply_rx) = mpsc::channel();
            let _ = tx.send(RecorderCmd::Cancel(reply_tx));
            let _ = reply_rx.recv();
        }
        self.close_session()?;
        Ok(())
    }

    /// Tear down the session: shut down the worker, join the thread.
    pub fn close_session(&mut self) -> Result<()> {
        if let Some(tx) = self.cmd_tx.take() {
            let _ = tx.send(RecorderCmd::Shutdown);
        }
        if let Some(handle) = self.worker_handle.take() {
            let _ = handle.join();
        }
        self.current_recording_id = None;
        debug!("Recording session closed");
        Ok(())
    }

    /// Recording id of the active session, if any. Surfaced for the JS
    /// reload-reattach path: only returns while the recorder is actively
    /// capturing, so a stopped-but-not-closed session does not look live.
    pub fn get_current_recording_id(&self) -> Option<String> {
        if self.is_recording.load(Ordering::Acquire) {
            self.current_recording_id.clone()
        } else {
            None
        }
    }

    /// Session id without the is_recording gate. Used by `stop_recording`
    /// to address the artifact write after the worker has already flipped
    /// the recording flag down.
    pub fn session_id(&self) -> Option<String> {
        self.current_recording_id.clone()
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        let _ = self.close_session();
    }
}

/// Consumer worker entrypoint. Accumulates mono samples, resamples to
/// 16 kHz at finalize, pads short clips, emits the artifact.
fn run_consumer(
    sample_rx: mpsc::Receiver<Vec<f32>>,
    cmd_rx: mpsc::Receiver<RecorderCmd>,
    device_rate: u32,
    is_recording: Arc<AtomicBool>,
) {
    use std::sync::mpsc::RecvTimeoutError;

    let mut recording = false;
    let mut buffer: Vec<f32> = Vec::new();

    loop {
        // Command channel has priority. Stop should respond fast even
        // when audio frames are arriving back-to-back.
        if let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                RecorderCmd::Start(reply) => {
                    recording = true;
                    is_recording.store(true, Ordering::Release);
                    buffer.clear();
                    let _ = reply.send(());
                    continue;
                }
                RecorderCmd::Stop(reply) => {
                    is_recording.store(false, Ordering::Release);
                    let result = finalize(std::mem::take(&mut buffer), device_rate);
                    let _ = reply.send(result);
                    return;
                }
                RecorderCmd::Cancel(reply) => {
                    is_recording.store(false, Ordering::Release);
                    let _ = reply.send(Ok(()));
                    return;
                }
                RecorderCmd::Shutdown => {
                    is_recording.store(false, Ordering::Release);
                    return;
                }
            }
        }

        match sample_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(samples) => {
                if recording {
                    buffer.extend_from_slice(&samples);
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Resample to 16 kHz if needed, pad short clips, build the samples.
fn finalize(buffer: Vec<f32>, device_rate: u32) -> Result<Vec<f32>> {
    let samples = if device_rate == TARGET_RATE {
        buffer
    } else {
        resample_mono(buffer, device_rate, TARGET_RATE)
            .map_err(|e| format!("resample failed: {e}"))?
    };

    let mut samples = samples;
    let samples_per_second = TARGET_RATE as usize;
    if !samples.is_empty()
        && samples.len() < samples_per_second
        && samples.len() < SHORT_RECORDING_PAD_SAMPLES
    {
        samples.resize(SHORT_RECORDING_PAD_SAMPLES, 0.0);
    }

    Ok(samples)
}

/// Find a recording device by name. Treats "default" case-insensitively.
fn find_device(host: &cpal::Host, device_name: &str) -> Result<Device> {
    if device_name.to_lowercase() == "default" {
        return host
            .default_input_device()
            .ok_or_else(|| "No default input device available".to_string());
    }

    let devices: Vec<_> = host.input_devices().map_err(|e| e.to_string())?.collect();
    for device in devices {
        if let Ok(name) = device.name() {
            if name == device_name {
                return Ok(device);
            }
        }
    }
    Err(format!("Device '{device_name}' not found"))
}

/// Get the best supported configuration for voice recording.
///
/// Prefers mono at the target rate (16 kHz default), falls back to stereo
/// at the target rate, then to the closest supported rate.
fn get_optimal_config(
    device: &Device,
    preferred_sample_rate: Option<u32>,
) -> Result<cpal::SupportedStreamConfig> {
    let target_sample_rate = preferred_sample_rate.unwrap_or(TARGET_RATE);

    let configs: Vec<_> = device
        .supported_input_configs()
        .map_err(|e| e.to_string())?
        .collect();
    if configs.is_empty() {
        return Err("No supported input configurations".to_string());
    }

    let supported_formats = [SampleFormat::F32, SampleFormat::I16, SampleFormat::U16];
    let compatible_configs: Vec<_> = configs
        .iter()
        .filter(|config| supported_formats.contains(&config.sample_format()))
        .collect();
    if compatible_configs.is_empty() {
        return Err("No configurations with supported sample formats (F32, I16, U16)".to_string());
    }

    // Mono at target rate if possible.
    for config in &compatible_configs {
        if config.channels() == 1 {
            let (min, max) = (config.min_sample_rate().0, config.max_sample_rate().0);
            if min <= target_sample_rate && max >= target_sample_rate {
                return Ok(config.with_sample_rate(cpal::SampleRate(target_sample_rate)));
            }
        }
    }

    // Any channel count at target rate.
    for config in &compatible_configs {
        let (min, max) = (config.min_sample_rate().0, config.max_sample_rate().0);
        if min <= target_sample_rate && max >= target_sample_rate {
            return Ok(config.with_sample_rate(cpal::SampleRate(target_sample_rate)));
        }
    }

    // Closest-rate fallback, preferring mono.
    let mut best_config: Option<cpal::SupportedStreamConfig> = None;
    let mut best_diff = u32::MAX;
    for config in &compatible_configs {
        if config.channels() != 1 {
            continue;
        }
        let (min, max) = (config.min_sample_rate().0, config.max_sample_rate().0);
        let closest = if target_sample_rate < min {
            min
        } else if target_sample_rate > max {
            max
        } else {
            target_sample_rate
        };
        let diff = (closest as i32 - target_sample_rate as i32).unsigned_abs();
        if diff < best_diff {
            best_diff = diff;
            best_config = Some(config.with_sample_rate(cpal::SampleRate(closest)));
        }
    }

    if best_config.is_none() {
        let config = compatible_configs[0];
        let (min, max) = (config.min_sample_rate().0, config.max_sample_rate().0);
        let rate = if min <= target_sample_rate && max >= target_sample_rate {
            target_sample_rate
        } else {
            min
        };
        best_config = Some(config.with_sample_rate(cpal::SampleRate(rate)));
    }

    best_config.ok_or_else(|| "Failed to find suitable audio configuration".to_string())
}

/// Build the cpal input stream. The callback's only job is to downmix to
/// mono f32 and send the chunk down `sample_tx`; the consumer worker owns
/// everything else.
fn build_input_stream(
    device: &Device,
    config: &cpal::StreamConfig,
    sample_format: SampleFormat,
    channels: u16,
    sample_tx: mpsc::Sender<Vec<f32>>,
) -> Result<Stream> {
    let err_fn = |err| error!("Audio stream error: {err}");
    let n_channels = channels as usize;

    let stream = match sample_format {
        SampleFormat::F32 => device
            .build_input_stream(
                config,
                move |data: &[f32], _: &_| {
                    let _ = sample_tx.send(downmix_f32(data, n_channels));
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("Failed to build F32 stream: {e}"))?,
        SampleFormat::I16 => device
            .build_input_stream(
                config,
                move |data: &[i16], _: &_| {
                    let _ = sample_tx.send(downmix_i16(data, n_channels));
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("Failed to build I16 stream: {e}"))?,
        SampleFormat::U16 => device
            .build_input_stream(
                config,
                move |data: &[u16], _: &_| {
                    let _ = sample_tx.send(downmix_u16(data, n_channels));
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("Failed to build U16 stream: {e}"))?,
        _ => return Err(format!("Unsupported sample format: {sample_format:?}")),
    };

    Ok(stream)
}

fn downmix_f32(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

fn downmix_i16(interleaved: &[i16], channels: usize) -> Vec<f32> {
    let scale = 1.0 / i16::MAX as f32;
    if channels <= 1 {
        return interleaved.iter().map(|&s| s as f32 * scale).collect();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().map(|&s| s as f32 * scale).sum::<f32>() / channels as f32)
        .collect()
}

fn downmix_u16(interleaved: &[u16], channels: usize) -> Vec<f32> {
    // u16 PCM: midpoint is 32768. Normalize to [-1, 1] via (x / max) * 2 - 1.
    let half = u16::MAX as f32 * 0.5;
    let to_f32 = |s: u16| (s as f32 / half) - 1.0;
    if channels <= 1 {
        return interleaved.iter().copied().map(to_f32).collect();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().copied().map(to_f32).sum::<f32>() / channels as f32)
        .collect()
}

/// Categorize a raw cpal/audio error message as "microphone access was denied".
///
/// cpal surfaces permission denials as opaque platform strings; we string-match
/// them so the JS side can show a "please grant mic permission" UI instead of a
/// generic error toast.
///
/// Inspired by Handy (MIT licensed):
/// https://github.com/cjpais/Handy/blob/main/src-tauri/src/audio_toolkit/audio/recorder.rs
/// (`is_microphone_access_denied`)
pub fn is_microphone_access_denied(error_message: &str) -> bool {
    let normalized = error_message.to_lowercase();
    normalized.contains("access is denied")
        || normalized.contains("permission denied")
        // Windows WASAPI HRESULT E_ACCESSDENIED.
        || normalized.contains("0x80070005")
}

/// Categorize a raw cpal/audio error message as "no input device available".
///
/// CoreAudio in particular produces an unhelpful "Failed to fetch preferred
/// config" / "An unknown error" string when no input device is connected;
/// match it here so the JS side can show a "please plug in a microphone" UI.
///
/// Inspired by Handy (MIT licensed):
/// https://github.com/cjpais/Handy/blob/main/src-tauri/src/audio_toolkit/audio/recorder.rs
/// (`is_no_input_device_error`)
pub fn is_no_input_device_error(error_message: &str) -> bool {
    let normalized = error_message.to_lowercase();
    normalized.contains("no input device found")
        || normalized.contains("no default input device available")
        || (normalized.contains("failed to fetch preferred config")
            && normalized.contains("coreaudio"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_access_is_denied() {
        assert!(is_microphone_access_denied("Access is denied"));
    }

    #[test]
    fn detects_permission_denied() {
        assert!(is_microphone_access_denied("permission denied"));
    }

    #[test]
    fn detects_windows_error_code() {
        assert!(is_microphone_access_denied("WASAPI error: 0x80070005"));
    }

    #[test]
    fn does_not_match_unrelated_permission_errors() {
        assert!(!is_microphone_access_denied("device not found"));
    }

    #[test]
    fn detects_no_input_device() {
        assert!(is_no_input_device_error("No input device found"));
    }

    #[test]
    fn detects_no_default_input_device() {
        assert!(is_no_input_device_error(
            "No default input device available"
        ));
    }

    #[test]
    fn detects_coreaudio_config_error() {
        assert!(is_no_input_device_error(
            "Failed to fetch preferred config: A backend-specific error has occurred: An unknown error unknown to the coreaudio-rs API occurred"
        ));
    }

    #[test]
    fn does_not_match_permission_errors_as_no_device() {
        assert!(!is_no_input_device_error("permission denied"));
        assert!(!is_no_input_device_error("device not found"));
    }

    #[test]
    fn downmix_stereo_to_mono_averages_pairs() {
        let stereo = vec![0.5_f32, -0.5, 1.0, -1.0];
        let mono = downmix_f32(&stereo, 2);
        assert_eq!(mono, vec![0.0, 0.0]);
    }

    #[test]
    fn downmix_mono_is_identity() {
        let input = vec![0.1_f32, 0.2, 0.3];
        let mono = downmix_f32(&input, 1);
        assert_eq!(mono, input);
    }
}
