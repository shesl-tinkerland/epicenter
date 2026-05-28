# Canonical Recorder

**Date**: 2026-05-26
**Status**: Draft
**Owner**: Braden
**Branch**: `braden-w/canonical-recorder` (proposed)

## How to read this spec

```
Read first:
  One Sentence
  Current Shape
  Target Shape
  Proof
  Implementation Plan (Phase 1)

Read if you are doing the refactor:
  Architecture
  Catalogs (AudioArtifact, Sink, RecorderPolicy)
  Call Sites
  Edge Cases

Read if you are changing the design:
  Motivation
  Research Findings (Whispering vs Handy)
  Design Decisions
  Open Questions
```

## One Sentence

Whispering's Rust recorder becomes a single two-thread pipeline whose consumer worker emits a tagged `AudioArtifact` (PCM in memory for dictation, native-rate WAV file for longform), so transcription consumes `Vec<f32>` directly on the cpal path and progressive WAV writing is reserved for the longform sink.

## Current Shape

```
cpal callback (recorder.rs:429)
  → locks Arc<Mutex<WavWriter>>
  → writes f32 LE bytes to disk now
  → updates RIFF/data header every ~1 s (wav_writer.rs:89)
       │
stop_recording
  → finalizes WAV (pads <1s clips to 1.25s, wav_writer.rs:195)
  → returns AudioRecording { file_path, sample_rate, channels, duration_seconds, audio_data: Vec<f32> /* always empty */ }
       │
JS reads file via pathToBlob → Blob (cpal.tauri.ts:131)
       │
transcribeBlob (transcribe.ts:58)
  ├─ cloud: encodeWavToOpusOgg → Symphonia decode + resample + opus encode → upload
  └─ local: decode_to_pcm16k_mono → Symphonia decode + resample
```

Five conversion hops on the cloud cpal path; two are pure round-trip. `audio_data: Vec<f32>` is a vestigial field. The mic is "warm" only between `init_session` and `start_recording` (a few ms, no useful latency win).

## Target Shape

```
cpal callback
  → mono downmix
  → sample_tx.send(AudioChunk::Samples(Vec<f32>))     // mpsc, never blocks
       │
consumer worker
  → resample to 16 kHz mono (policy: dictation only)
  → level meter (always, cheap)
  → VAD (policy: off | trim | gate; default off)
  → sink:
      MemorySink: push into Vec<f32>
      ProgressiveWavSink: write to native-rate WAV on disk
       │
stop_recording → AudioArtifact:
   ├─ Pcm  { samples: Vec<f32>, rate: u32, channels: u16 }      (dictation default)
   ├─ File { path: PathBuf, rate, channels, container: Wav }    (longform)
   └─ Blob { bytes, mime }                                       (navigator only)
       │
transcribe(artifact)
   ├─ cloud + Pcm  → encode f32 → opus → upload         (one encode hop)
   ├─ cloud + File → existing path                       (longform; rare)
   ├─ local + Pcm  → pass through                         (zero hops)
   └─ local + File → decode_to_pcm16k_mono               (longform; rare)
```

## Proof

- `recorder.rs` has a consumer worker thread; the cpal callback's only writes are into an `mpsc::Sender`.
- `wav_writer.rs` is reachable only when `recording.mode = 'longform'` is selected.
- For `recording.mode = 'dictation'` (the default), `stop_recording` returns `AudioArtifact::Pcm` with no file on disk.
- On the cloud cpal dictation path, `encode_wav_to_opus_ogg` is no longer called; a new `encode_pcm_to_opus_ogg` takes `&[f32]` directly.
- `transcribe.ts` no longer round-trips through `pathToBlob` for dictation cpal recordings.
- Short-clip padding is applied at consumer-stop time, not inside `wav_writer.rs`.
- The empty `audio_data: Vec<f32>` field on `AudioRecording` is gone.

---

## Overview

Refactor `apps/whispering/src-tauri/src/recorder/` and the JS recorder service boundary so the recorder is one canonical pipeline with policy-driven sinks. Default behavior changes from "always write progressive WAV" to "buffer 16k mono PCM in memory for dictation; write native-rate WAV only when the user opts into longform." VAD and mic-warmness modes are scoped as **future additive work** built on top of the same pipeline; they are not part of this spec's required scope.

## Motivation

### Current state

The cpal-backed recorder writes WAV bytes directly inside the cpal audio callback (`recorder.rs:429-466`):

```rust
device.build_input_stream(
    config,
    move |data: &[f32], _: &_| {
        if is_recording.load(Ordering::Relaxed) {
            if let Ok(mut w) = writer.lock() {
                let _ = w.write_samples_f32(data);
            }
        }
    },
    err_fn,
    None,
)
```

The WAV file lands on disk; JS reads it back as a Blob (`cpal.tauri.ts:131`); for cloud upload, Rust then decodes the WAV and re-encodes to Opus (`transcribe.ts:80`, `encode.rs:53`).

This creates problems:

1. **Audio callback contention**: A `Mutex` lock + synchronous disk write inside the cpal callback is a known glitch source. Audio callbacks must never block.
2. **Wasted round-trips for transcription**: Five conversion hops (f32 → WAV bytes → disk → Blob → decode → re-encode) for what started as f32 samples. On the cloud cpal path, **two of those hops are pure undo-and-redo**.
3. **Wrong default for short clips**: A 3-second PTT recording pays disk-write cost for a durability guarantee no user expects. Crash mid-PTT loses 3 seconds, which is not a user-visible failure mode.
4. **Padding is in the wrong place**: `wav_writer.rs:195` applies a Whisper-hallucination defense as a WAV-format concern. If we ever skip WAV, we silently drop the defense.
5. **Vestigial API**: `AudioRecording.audio_data: Vec<f32>` (`recorder.rs:18`) is documented as "Empty for file-based recording" and is always empty. Fake field.
6. **Conflated mic-warmth and storage**: Today's "stream up between init_session and start_recording" gives privacy cost (orange dot) without latency benefit (the two calls run back-to-back). Warmness is a separate policy axis that does not exist.

### Desired state

```ts
// dictation, the default: no disk involved on capture
const { artifact } = await recorder.stop();
// artifact: { kind: 'pcm', samples: Float32Array, rate: 16000, channels: 1 }

// transcribe sees PCM and skips the decode roundtrip
await transcribeArtifact(artifact);
```

```ts
// longform: disk-backed, native rate, crash-safe
const { artifact } = await recorder.stop();
// artifact: { kind: 'file', path: '/.../recordings/abc.wav', rate: 48000, channels: 1, container: 'wav' }
```

The cpal callback only ever does `sample_tx.send(...)`. Everything else lives in the consumer worker, which makes sink choice, resampling, VAD, and short-clip padding all consumer-thread concerns.

## Research Findings

### Whispering vs Handy

Verified against `cjpais/Handy` at `src-tauri/src/audio_toolkit/audio/recorder.rs` and `src-tauri/src/managers/audio.rs`:

```rust
// Handy
enum Cmd { Start, Stop(mpsc::Sender<Vec<f32>>), Shutdown }
enum AudioChunk { Samples(Vec<f32>), EndOfStream }

fn build_stream(device, config, sample_tx: mpsc::Sender<AudioChunk>, channels, stop_flag)
fn run_consumer(in_sample_rate, vad, sample_rx, cmd_rx, level_cb, stop_flag)

pub fn stop_recording(&self, binding_id: &str) -> Option<Vec<f32>>
// + lazy-close 30s timer; MicrophoneMode { AlwaysOn, OnDemand }
// + short-clip pad in MANAGER: if s_len < WHISPER_SAMPLE_RATE: padded.resize(SR * 5/4, 0.0)
```

| Concern | Handy | Whispering today | Target |
|---|---|---|---|
| Disk writes during capture | never | every callback | only for longform sink |
| Stream callback work | downmix + mpsc::send | Mutex lock + disk write | downmix + mpsc::send |
| Consumer thread | yes, owns resample+VAD+buffer | none | yes, owns sink + policy |
| Recorder output | `Vec<f32>` 16k mono | WAV file path | tagged `AudioArtifact` |
| VAD | SileroVad + prefill_frames | none | none (future, additive) |
| Resample at capture | yes (FrameResampler → 16k) | no (deferred to decode.rs) | yes, dictation only |
| Mic warmness | AlwaysOn / OnDemand + 30s lazy close | accidental + useless | none (future, additive) |
| Padding location | manager, on stop | inside WavWriter::finalize | consumer, on stop |
| Reload survival | none apparent | `get_current_recording_id` | preserved |
| Transcription input | `Vec<f32>` directly | `Blob` (WAV bytes) | `AudioArtifact` |
| History saved | post-VAD 16k mono WAV via `save_wav_file` | not yet wired in code reviewed | n/a this spec |

**Key finding**: Handy and Whispering are reasonable extremes of the same design space. Handy optimizes for low-latency dictation and pays the cost of "no long-recording crash safety." Whispering optimizes for crash safety and pays the cost of "wasted hops for short clips." A single recorder with a policy-driven sink choice gets both wins.

**Implication**: Neither codebase's choice is universally correct. The asymmetry is the point.

## Design Decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| Pipeline shape | 2 coherence | Two threads: cpal callback → mpsc → consumer worker | Mirrors Handy; required to keep audio callback lock-free |
| Mono downmix location | 1 evidence | Inside callback before send | Handy's `build_stream` does this; minimizes channel-message size |
| Resample location | 2 coherence | Consumer worker, dictation-mode only | Longform preserves native rate for future re-transcription with better engines |
| Sink interface | 2 coherence | Trait with `write_chunk(&[f32])` and `finalize() -> AudioArtifact` | Lets the worker treat memory and progressive sinks identically |
| Default sink | 3 taste | Memory | PTT and dictation are the dominant workflows; longform is a deliberate user choice |
| AudioArtifact crossing FFI | 2 coherence | Tagged union serialized via serde | Existing pattern in `AudioRecording`; minimal new infra |
| Short-clip padding location | 2 coherence | Move to consumer-stop step | Padding is a transcription concern, not a WAV concern |
| Padding gating by engine | 3 taste | Apply to all engines for now, plumb the gate later | Conservative: do not change observable hallucination defense in this PR |
| Transcription input shape | 2 coherence | New `transcribeArtifact(AudioArtifact)` entrypoint | Existing `transcribeBlob` becomes the navigator-only / file-upload path |
| Encoder takes `&[f32]` | 2 coherence | Add `encode_pcm_to_opus_ogg(samples, rate, channels)` | Avoid synthesizing a WAV just to decode it |
| Old encoder retention | 3 taste | Keep `encode_wav_to_opus_ogg` for now | Still used for `File` artifact path and possibly file uploads; revisit when those paths consolidate |
| Empty `audio_data` field | 1 evidence | Delete | Always empty today; nothing reads it |
| `is_recording: AtomicBool` | 3 taste | Keep | Cheap, well-understood; the warmness redesign is out of scope here |
| VAD | Deferred | Not in this spec | Additive on top of the consumer worker; ship the pipeline first |
| Mic warmness modes | Deferred | Not in this spec | Same reason. Default behavior stays as today: stream comes up at `init_session`, tears down at `close_session` |
| Reload survival shape | 2 coherence | Preserve existing `get_current_recording_id` | Already works; the new artifact shape does not change reattach semantics |
| Navigator path | 2 coherence | Keep producing `Blob`; transcription emits `Blob` artifact | Web platform cannot deliver the dictation guarantees; honest about limits |

## Architecture

### Threads and channels

```
┌─────────────────────────────────────────────────────────────────┐
│                        Recorder (Rust)                          │
│                                                                 │
│   ┌──────────────────────┐                                      │
│   │  cpal callback thread│   (one per stream, owned by cpal)    │
│   │                      │                                      │
│   │  - mono downmix      │                                      │
│   │  - sample_tx.send()  │                                      │
│   └──────────┬───────────┘                                      │
│              │ mpsc::Sender<AudioChunk>                          │
│              ▼                                                  │
│   ┌──────────────────────┐                                      │
│   │   consumer worker    │   (one per init_session)             │
│   │                      │                                      │
│   │  - recv AudioChunk   │                                      │
│   │  - if recording:     │                                      │
│   │     resample (policy)│                                      │
│   │     sink.write_chunk │                                      │
│   │  - recv Cmd:         │                                      │
│   │     Start/Stop/      │                                      │
│   │     Shutdown         │                                      │
│   └──────────┬───────────┘                                      │
│              │                                                  │
│              ▼                                                  │
│   ┌──────────────────────┐                                      │
│   │     Sink (trait)     │                                      │
│   │  - MemorySink        │                                      │
│   │  - ProgressiveWavSink│                                      │
│   └──────────┬───────────┘                                      │
│              │ on Stop(reply_tx):                               │
│              │   sink.finalize() -> AudioArtifact               │
│              ▼                                                  │
│   reply_tx.send(AudioArtifact)                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Lifecycle (unchanged from today, mechanics simpler)

```
init_session(device, output_folder, recording_id, sample_rate, mode)
  → build cpal stream (callback only sends; no writer needed)
  → spawn consumer worker (owns selected sink)
  → stream.play()
  → return Ok

start_recording
  → cmd_tx.send(Start) + await reply
  → consumer flips internal `recording` flag to true

stop_recording
  → cmd_tx.send(Stop(reply_tx))
  → consumer flushes channel, finalizes sink, emits AudioArtifact
  → return AudioArtifact

cancel_recording
  → cmd_tx.send(Stop(reply_tx)); drop artifact
  → if file: remove path

close_session
  → cmd_tx.send(Shutdown)
  → worker drains and exits; stream drops
```

## The `AudioArtifact` catalog

```rust
// Rust side
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AudioArtifact {
    Pcm {
        samples: Vec<f32>,        // mono interleave
        rate: u32,                 // typically 16000 for dictation
        channels: u16,             // typically 1
        duration_seconds: f32,
    },
    File {
        path: String,
        rate: u32,
        channels: u16,
        duration_seconds: f32,
        container: AudioContainer, // "wav" today; "ogg-opus" later
    },
    Blob {
        bytes: Vec<u8>,
        mime: String,
        duration_seconds: f32,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioContainer { Wav, OggOpus }
```

```ts
// TS side (parallel)
type AudioArtifact =
  | { kind: 'pcm'; samples: Float32Array; rate: number; channels: number; durationSeconds: number }
  | { kind: 'file'; path: string; rate: number; channels: number; durationSeconds: number; container: 'wav' | 'ogg-opus' }
  | { kind: 'blob'; bytes: Uint8Array; mime: string; durationSeconds: number };
```

**Rejected variants**:

| Candidate | Why rejected |
|---|---|
| Single `{ blob, kind }` shape | Forces materializing file bytes in JS for longform; defeats the file sink |
| `{ samples: Vec<f32>, file: Option<PathBuf> }` | Two fields, only one ever set; tagged union is honest |
| Include `recordingId` in the artifact | Owned by the caller (manual-recorder), not the recorder; redundant here |

## The `Sink` catalog (Rust)

```rust
trait Sink: Send {
    fn write_chunk(&mut self, samples: &[f32]) -> Result<()>;
    fn finalize(self: Box<Self>, padding_target_samples: Option<usize>) -> Result<AudioArtifact>;
    fn cancel(self: Box<Self>) -> Result<()>; // delete file if any
}

struct MemorySink { samples: Vec<f32>, rate: u32, channels: u16 }
struct ProgressiveWavSink { writer: WavWriter, rate: u32, channels: u16, samples_written: u64 }
```

**Rejected sinks**:

| Candidate | Why rejected for now |
|---|---|
| `ProgressiveOpusSink` | Worthwhile for longform but out of scope; revisit once `WavSink` is the only durable option in use |
| `FanOutSink` (memory + progressive) | Belongs to a future streaming mode; YAGNI |

## The `RecorderPolicy` catalog (Rust)

```rust
struct RecorderPolicy {
    sink: SinkKind,                  // Memory | ProgressiveWav
    resample_to_16k_mono: bool,      // true for dictation
    pad_short_recording: bool,       // true for dictation
}

impl RecorderPolicy {
    fn dictation() -> Self { Self { sink: SinkKind::Memory, resample_to_16k_mono: true, pad_short_recording: true } }
    fn longform()  -> Self { Self { sink: SinkKind::ProgressiveWav, resample_to_16k_mono: false, pad_short_recording: false } }
}
```

**Out of scope**:
- VAD policy (off / trim / gate): additive; future spec.
- Warmness policy (off / lazy-close / always-on): additive; future spec.
- Per-engine padding gate: defer until a local engine starts complaining about silence.

## Call sites: before and after

### Rust: cpal callback (`recorder.rs:425-468`)

**Before**:

```rust
let stream = match sample_format {
    SampleFormat::F32 => device.build_input_stream(
        config,
        move |data: &[f32], _: &_| {
            if is_recording.load(Ordering::Relaxed) {
                if let Ok(mut w) = writer.lock() {
                    let _ = w.write_samples_f32(data);
                }
            }
        },
        err_fn,
        None,
    )?,
    SampleFormat::I16 => /* ... similar ... */,
    SampleFormat::U16 => /* ... similar ... */,
};
```

**After**:

```rust
let stream = match sample_format {
    SampleFormat::F32 => device.build_input_stream(
        config,
        move |data: &[f32], _: &_| {
            let chunk = downmix_to_mono_f32(data, channels);
            // best-effort send; if consumer is gone, samples are dropped
            let _ = sample_tx.send(AudioChunk::Samples(chunk));
        },
        err_fn,
        None,
    )?,
    SampleFormat::I16 => /* convert to f32, downmix, send */,
    SampleFormat::U16 => /* convert to f32, downmix, send */,
};
```

**Semantic shift to flag**: The `is_recording` gate moves from the callback into the consumer worker. The callback always emits chunks; the consumer drops them when `!recording`. This is intentional (so we can in the future add pre-roll: keep the most recent N chunks in a ring even while idle). Privacy story is unchanged: the cpal stream is still only alive between `init_session` and `close_session`.

### Rust: stop_recording (`recorder.rs:198-236`)

**Before**:

```rust
pub fn stop_recording(&mut self) -> Result<AudioRecording> {
    // ... send Stop to worker ...
    let (sample_rate, channels, duration) = if let Some(writer) = &self.writer {
        let mut w = writer.lock()...;
        w.finalize()?;
        w.get_metadata()
    } else { (self.sample_rate, self.channels, 0.0) };
    let file_path = self.file_path.as_ref().map(|p| p.to_string_lossy().to_string());
    Ok(AudioRecording { audio_data: Vec::new(), sample_rate, channels, duration_seconds: duration, file_path })
}
```

**After**:

```rust
pub fn stop_recording(&mut self) -> Result<AudioArtifact> {
    let (reply_tx, reply_rx) = mpsc::channel();
    self.cmd_tx.as_ref()
        .ok_or("no active session")?
        .send(RecorderCmd::Stop(reply_tx))?;
    let artifact = reply_rx.recv()
        .map_err(|e| format!("worker dropped reply: {e}"))?;
    Ok(artifact)
}
```

### TS: cpal.tauri.ts stop (`cpal.tauri.ts:110-153`)

**Before**:

```ts
stop: async ({ sendStatus }) => {
    const { data: audioRecording, error: stopRecordingError } =
        await invoke<AudioRecording>('stop_recording');
    if (stopRecordingError) { /* ... */ }

    const { filePath, durationSeconds } = audioRecording;
    if (!filePath) { /* ... */ }
    const durationMs = Math.round(durationSeconds * 1000);

    sendStatus({ title: '📁 Reading Recording', /* ... */ });

    const blob = await readFileAsBlob(filePath);

    /* close session, teardown */
    return Ok({ blob, recordingId, durationMs });
},
```

**After**:

```ts
stop: async ({ sendStatus }) => {
    const { data: artifact, error } = await invoke<AudioArtifact>('stop_recording');
    if (error) { teardown(recording); return RecorderError.StopFailed({ cause: error }); }

    const durationMs = Math.round(artifact.durationSeconds * 1000);

    sendStatus({ title: '🔄 Closing Session', description: '...' });
    const { error: closeError } = await invoke<void>('close_recording_session');
    if (closeError) console.error('Failed to close recording session:', closeError);

    teardown(recording);
    return Ok({ artifact, recordingId, durationMs });
},
```

**Semantic shift to flag**: `Recording.stop` no longer returns `{ blob }`. It returns `{ artifact }`. Every caller of `manualRecorder.stopRecording` and `vadRecorder.stopRecording` must be updated to read `artifact` and dispatch. Search-and-replace at the boundary.

### TS: transcribe.ts (`transcribe.ts:58-104`)

**Before**:

```ts
export async function transcribeBlob(blob: Blob): Promise<Result<string, WhisperingError>> {
    // ... cloud-only: old path could round-trip bytes before upload ...
    let audioToTranscribe = blob;
    // dispatch on selectedService → services.transcriptions.X.transcribe(audioToTranscribe, ...)
}
```

**After**:

The current transcription boundary is id-based: callers save an artifact, then
call `transcribeAudio(recordingId)`. Cloud upload bytes are materialized by
`loadForCloudUpload(recordingId)`, which calls
`commands.encodeRecordingForUpload(recordingId)` on Tauri and falls back to the
blob store on web. This keeps upload encoding out of the Tauri namespace instead
of reintroducing an `audioEncoder` leaf.

**Semantic shift to flag**: `transcribeBlob` becomes a thin wrapper for legacy callers (file upload UI, etc.); the recorder path goes through `transcribeArtifact`. Local engines still see a `Blob` (no service-interface change in this spec); the wasted hops they took before are still gone because `pcmToWavBlob` is a few-microsecond shim, not a Symphonia round trip.

**Followup carve-out**: local engines should eventually consume `Vec<f32>` directly via a new service interface. Not this spec.

## Implementation Plan

### Wave 1: Build the new path (no behavior change yet)

- [ ] **1.1** Introduce `AudioChunk` and `RecorderCmd` enums (the new `Stop(mpsc::Sender<AudioArtifact>)` variant) in `recorder.rs`.
- [ ] **1.2** Introduce `AudioArtifact`, `AudioContainer`, `RecorderPolicy`, `SinkKind` types in a new `recorder/artifact.rs`.
- [ ] **1.3** Introduce `Sink` trait, `MemorySink`, `ProgressiveWavSink` in a new `recorder/sink.rs`. `ProgressiveWavSink` wraps the existing `WavWriter`.
- [ ] **1.4** Implement `run_consumer(sample_rx, cmd_rx, sink, policy)` worker function. Handles resample and pad-short-recording at finalize per policy.
- [ ] **1.5** Refactor `Recorder::init_session` to spawn the consumer worker and route the cpal callback into `sample_tx`. `init_session` gains a `policy: RecorderPolicy` parameter.
- [ ] **1.6** Refactor `Recorder::stop_recording` to return `AudioArtifact` via the new reply channel.
- [ ] **1.7** Delete `Recorder.writer: Option<Arc<Mutex<WavWriter>>>` and `Recorder.file_path`; ownership moves into the sink inside the consumer.
- [ ] **1.8** Update Tauri commands in `commands.rs`: `init_recording_session` accepts a `mode: 'dictation' | 'longform'` argument; `stop_recording` returns `AudioArtifact`.
- [ ] **1.9** Update TS types in `cpal.tauri.ts` (`AudioArtifact` shape).
- [ ] **1.10** Update `cpal.tauri.ts` to pass `mode` through `startRecording`; update `Recording.stop` to return `{ artifact, recordingId, durationMs }`.
- [ ] **1.11** Update navigator path: `Recording.stop` returns `{ artifact: { kind: 'blob', bytes, mime, durationSeconds }, recordingId, durationMs }`.
- [ ] **1.12** Update `manual-recorder.svelte.ts` to plumb a `mode` from settings (default `'dictation'`) into `buildStartParams`. The setting key already exists for cpal-related options; add `recording.mode` to `deviceConfig`.
- [ ] **1.13** Add `transcribeArtifact(AudioArtifact)` in `transcribe.ts`. Keep `transcribeBlob` working as a wrapper that builds a `kind: 'blob'` artifact.
- [ ] **1.14** Reuse the Rust upload encoder through `commands.encodeRecordingForUpload(recordingId)` instead of adding an `audioEncoder` namespace.

### Wave 2: Switch consumers to the new path

- [ ] **2.1** Switch `manualRecorder.stopRecording` callers to read `artifact` and call `transcribeArtifact`. (Codemod-friendly: every site that destructured `{ blob }` now destructures `{ artifact }`.)
- [ ] **2.2** Switch VAD recorder (`vadRecorder`) similarly. (Same shape change; navigator path so always `kind: 'blob'`.)
- [ ] **2.3** Switch `transformer.ts` and any other transcription-call paths that took `Blob` to take `AudioArtifact`. Wrap legacy file-upload UI to build a `kind: 'blob'` artifact.

### Wave 3: Prove

- [ ] **3.1** `bun run typecheck` clean across `apps/whispering`.
- [ ] **3.2** `cargo check` and `cargo test` for `src-tauri` clean.
- [ ] **3.3** Manual smoke: PTT dictation (cpal) end-to-end with each of OpenAI, Groq, whispercpp.
- [ ] **3.4** Manual smoke: longform mode (cpal) records to disk, transcribes through OpenAI as file artifact.
- [ ] **3.5** Manual smoke: navigator path on web build, OpenAI transcription.
- [ ] **3.6** Manual smoke: cancel mid-recording in both modes; verify no orphan file in longform.
- [ ] **3.7** Manual smoke: JS reload mid-recording (cpal, dictation and longform) reattaches and stop returns a valid artifact.
- [ ] **3.8** Confirm short-clip padding still applied (<1s PTT does not Whisper-hallucinate "Thank you for watching").

### Wave 4: Remove the dead path

- [ ] **4.1** Delete `AudioRecording` struct (`recorder.rs:17-23`) and `audio_data: Vec<f32>`.
- [ ] **4.2** Delete `pad_short_recording` from `wav_writer.rs` (it now lives in the consumer; `WavWriter` becomes a pure WAV-writing primitive).
- [ ] **4.3** Audit file-to-Blob call sites; if cpal stop was the only caller, mark and remove if dead.
- [ ] **4.4** Audit `encodeWavToOpusOgg` JS callers; if dictation path no longer calls it, keep the Rust function (longform may use it) but document.

### Wave 5 (deferred, not in this spec)

- VAD with pre-roll, policy `off | trim | gate`.
- `MicrophoneMode { Off, LazyClose(Duration), AlwaysOn }`.
- Local engines accept `Vec<f32>` directly via new service interface.

## Edge Cases

### JS reload during dictation recording (cpal)

1. User starts PTT recording in dictation mode (memory sink).
2. JS reloads (devtools, hot reload, user nav).
3. Rust consumer worker still alive, samples still accumulating in `MemorySink.samples: Vec<f32>`.
4. `manual-recorder.svelte.ts` bootstrap calls `get_current_recording_id`; gets back the id.
5. New `Recording` wrapper attached; user stops via UI.
6. `stop_recording` returns `AudioArtifact::Pcm { samples, rate: 16000, ... }`.
7. **Expected**: same flow as without reload. No data loss for the active recording.

### Process crash during dictation recording

1. Recording in memory sink. Process crashes.
2. **Expected**: clip lost. This is acceptable for dictation; documented.

### Process crash during longform recording

1. Recording in progressive WAV sink. Process crashes.
2. WAV file on disk, last header update was up to 1 s ago.
3. **Expected**: file is playable to the last 1 s. Same guarantee as today's WAV writer.
4. On next launch, no automatic recovery (out of scope); user finds the file in the recordings folder.

### Cancel during longform

1. User cancels longform recording.
2. Consumer worker `cancel()`s the `ProgressiveWavSink`, which removes the on-disk file.
3. **Expected**: no orphan file in the recordings directory.

### Very short PTT (<1 s) in dictation mode

1. User taps and releases hotkey in under 1 s.
2. Consumer accumulates ~16k or fewer samples.
3. On stop, consumer calls `pad_short_recording` on the in-memory `Vec<f32>` before emitting the artifact (target: 20000 samples = 1.25 s at 16 kHz).
4. **Expected**: same hallucination defense as today, applied in memory.

### Sample-rate mismatch

1. Device negotiates 44.1 kHz (Bluetooth headset).
2. Dictation mode: consumer resamples to 16 kHz inside the worker before writing to `MemorySink`.
3. Longform mode: consumer passes through native rate to `ProgressiveWavSink`; WAV records at 44.1 kHz.
4. **Expected**: PCM artifact always reports `rate: 16000`; file artifact reports the native rate.

### Worker thread panic

1. Consumer worker panics (resampler bug, sink I/O error).
2. `reply_tx` for the next Stop is dropped; `reply_rx.recv()` errors with "worker dropped reply."
3. **Expected**: surface as `RecorderError.StopFailed`. JS catches and shows toast. Session must be re-init.

## Open Questions

1. **Should `Recording.stop` return `{ artifact, recordingId, durationMs }` or just `{ artifact }`?**
   - `recordingId` is owned by the caller already (it was passed at start time); `durationMs` is on the artifact.
   - **Recommendation**: return just `{ artifact }`. The other fields are redundant.

2. **Should the navigator path also wrap its output in `AudioArtifact`?**
   - Pro: one shape everywhere downstream; transcription dispatch has one entry point.
   - Con: navigator's Blob has a mime type that varies (webm/opus on Chrome, mp4 on Safari); `kind: 'blob'` faithfully represents this.
   - **Recommendation**: yes, wrap as `kind: 'blob'`. This is the spec's default.

3. **Should `ProgressiveWavSink` write at native rate or resampled-to-16k for longform?**
   - Native preserves audio fidelity for future re-transcription with better models.
   - 16k saves disk and trims the artifact to what transcription actually consumes.
   - **Recommendation**: native. The point of longform is fidelity; if a user opts in, give them the real thing.

4. **What user-facing setting controls dictation vs longform?**
   - Could be a toggle in settings ("Recording mode: dictation / longform"), or an automatic switch based on hotkey-vs-button.
   - **Recommendation**: explicit setting, hidden behind "Advanced." Most users never need to think about it. Default `dictation`. Defer the UI to a follow-up; ship the plumbing with `dictation` as the only currently-selected mode.

5. **Do we deprecate `encodeWavToOpusOgg` immediately?**
   - It still has the file artifact path as a customer (longform → cloud transcription).
   - **Recommendation**: keep it; rename the new function `encodePcmToOpusOgg` to make the parallel explicit. Both live in `encode.rs`.

6. **Should resampling be in the consumer or be a separate stage?**
   - Today, resample is in the worker (per Handy). Could become its own worker thread if it ever becomes a CPU hotspot.
   - **Recommendation**: in the consumer for now. Splitting adds channels and complexity; revisit if profiling shows it matters.

## Success Criteria

- [ ] Dictation cpal recording stops emit `AudioArtifact::Pcm { samples, rate: 16000, channels: 1 }`.
- [ ] Cloud transcription of a dictation cpal recording does **not** call `encodeWavToOpusOgg`; it calls `encodePcmToOpusOgg`.
- [ ] Cloud transcription on a 5-second dictation clip is at least as fast as before. (Floor: not regressed; ceiling: faster.)
- [ ] Longform cpal recording produces a WAV file on disk at the device's native rate; the file plays back end-to-end.
- [ ] Cancelling a longform recording leaves no file in the recordings directory.
- [ ] JS reload mid-dictation reattaches and `stop` returns a valid `Pcm` artifact.
- [ ] `cargo check`, `cargo test`, and `bun run typecheck` pass.
- [ ] `AudioRecording.audio_data: Vec<f32>` no longer exists in the codebase.
- [ ] Short-clip padding (<1 s → 1.25 s) still observable in dictation transcription quality.

## References

- `apps/whispering/src-tauri/src/recorder/recorder.rs`: main refactor target
- `apps/whispering/src-tauri/src/recorder/wav_writer.rs`: keep as sink primitive; remove padding from here
- `apps/whispering/src-tauri/src/recorder/commands.rs`: Tauri command signatures change
- `apps/whispering/src/lib/services/recorder/cpal.tauri.ts`: TS boundary, artifact shape
- `apps/whispering/src/lib/services/recorder/navigator.ts`: wrap blob output as artifact
- `apps/whispering/src/lib/state/manual-recorder.svelte.ts`: plumb `mode` through start params
- `apps/whispering/src/lib/operations/transcribe.ts`: add `transcribeArtifact`
- `apps/whispering/src-tauri/src/audio/encode.rs`: add `encode_pcm_to_opus_ogg`
- `cjpais/Handy:src-tauri/src/audio_toolkit/audio/recorder.rs`: reference implementation
- `cjpais/Handy:src-tauri/src/managers/audio.rs`: padding placement, lazy-close pattern (deferred)

## Review (2026-05-26)

### Changes landed

**Rust**:
- `src-tauri/src/recorder/artifact.rs` new: `AudioArtifact`, `AudioContainer`, `SinkKind`, `RecorderPolicy`, `RecorderMode`.
- `src-tauri/src/recorder/sink.rs` new: `Sink` trait, `MemorySink`, `ProgressiveWavSink`. ProgressiveWavSink wraps the existing `WavWriter`.
- `src-tauri/src/recorder/recorder.rs` rewritten: two-thread pipeline (cpal callback + consumer worker), `mpsc<AudioChunk>` between them, `Recorder` no longer holds the writer or file path. `recording_id` lives on `Recorder` so `get_current_recording_id` continues to support reload reattach.
- `src-tauri/src/recorder/commands.rs`: `init_recording_session` accepts optional `mode: 'dictation' | 'longform'`; `stop_recording` returns `AudioArtifact`.
- `src-tauri/src/recorder/wav_writer.rs`: removed `pad_short_recording` (now in sink finalize). WAV writer is now a pure WAV-writing primitive.
- `src-tauri/src/audio/encode.rs`: new `encode_pcm_to_opus_ogg(samples, rate, channels)`. `encode_wav_to_opus_ogg` now delegates to it after WAV decode.
- `src-tauri/src/audio/command.rs`: new `encode_upload_pcm` Tauri command (binary IPC body `[u32 rate][u16 channels][u16 pad][f32 samples...]`).
- `src-tauri/src/lib.rs`: registered `encode_upload_pcm`.

**TypeScript**:
- `src/lib/services/recorder/types.ts`: added `AudioArtifact` tagged union (`pcm | blob`). The artifact describes the audio payload only; `Recording.stop` returns `{ artifact, recordingId, durationMs }` for capture-session metadata. Removed unused `RecorderError` variants (`NotRecording`, `NoFilePath`, `EmptyRecording`, `FileDeleteFailed`).
- `src/lib/services/recorder/artifact.ts` new: `artifactToBlob` materializes any artifact to a `Blob` (in-memory WAV synthesis for `pcm`, identity for `blob`).
- `src/lib/services/recorder/cpal.tauri.ts` rewritten: `Recording.stop` returns the artifact; `samples: number[]` from IPC is hydrated to `Float32Array`; cancel goes through new `cancel_recording` command without the explicit `stop_recording`/file-delete dance.
- `src/lib/services/recorder/navigator.ts`: stops emit `{ artifact: { kind: 'blob', blob }, recordingId, durationMs }`.
- `src/lib/state/manual-recorder.svelte.ts`: passes `mode: 'dictation'` in cpal start params.
- `src/lib/tauri/commands.ts`: upload encoding goes through `commands.encodeRecordingForUpload(recordingId)`.
- `src/lib/operations/transcribe.ts`: new `transcribeArtifact(artifact)`. Pcm + cloud upload skips the WAV round-trip and goes straight through `encodePcmToOpusOgg`. `transcribeBlob` is now a thin wrapper for the history re-transcribe path.
- `src/lib/operations/pipeline.ts`: takes `artifact` instead of `blob`. History save uses `artifactToBlob`; transcription uses `transcribeArtifact`.
- `src/lib/operations/recording.ts`: manual + VAD callers wrap their output as `AudioArtifact`. Analytics size derives from artifact kind.
- `src/lib/operations/upload.ts`: file-upload UI wraps as `kind: 'blob'` artifact.

### Verification

- `cargo check` clean, no warnings.
- `cargo test --lib recorder` 10/10 passing.
- `bun run typecheck` clean for this app (the two remaining errors are pre-existing `@epicenter/util` import failures unrelated to this work).

### Smoke tests still needed (runtime)

- Manual cpal PTT end-to-end with OpenAI / Groq / whispercpp.
- Cancel mid-recording (no orphan file).
- JS reload mid-recording (`get_current_recording_id` reattach).
- Short clip (<1s) padded to 1.25s; Whisper does not hallucinate.
- Sample-rate mismatch (Bluetooth headset @ 44.1 kHz) resampled to 16 kHz in artifact.

### Post-build simplifications (vs the spec's catalogs)

The catalogs above sketched a richer config surface than the work actually needs. Trimmed before commit:

- **Dropped `RecorderPolicy` struct and `SinkKind` enum**: every axis is determined by `RecorderMode`. The struct was a "would be nice if we ever needed it" speculation; nothing varies independently. Now `recorder.rs::init_session` and `run_consumer` match on `RecorderMode` directly.
- **Dropped `AudioChunk` enum**: the wrapper had one variant (`Samples(Vec<f32>)`). The channel is now `mpsc::Sender<Vec<f32>>` directly.
- **Dropped `Default for RecorderMode` and `mode: Option<RecorderMode>` in the Tauri command**: the JS caller always passes `mode` explicitly. The Option/default was defensive ceremony.
- **Dropped `durationSeconds` from `AudioArtifact`**: blob producers cannot know duration without decoding, and PCM duration is derivable from `samples`, `rate`, and `channels`. The canonical "how long was this recording" number lives on `Recording.stop`'s return.
- **Tightened cancel**: `cancel_recording` now does the full Rust-side cleanup in one call; the JS-side follow-up `close_recording_session` invoke was removed. One IPC round trip per cancel instead of two.
- **Trimmed `recorder/mod.rs` re-exports**: removed `AudioContainer` and `RecorderPolicy` from the public surface (they were unused outside the module).

### Follow-ups (out of scope here)

- Longform mode UI (the policy plumbing exists; only the user-facing switch is missing).
- VAD with pre-roll for first-word fidelity.
- `MicrophoneMode` lazy-close-30s for back-to-back PTT.
- Binary IPC for `stop_recording` if the Vec<f32> JSON cost becomes load-bearing for longer dictation clips.
- Local engines consuming `Vec<f32>` directly (skip the `pcmToWavBlob` shim).
