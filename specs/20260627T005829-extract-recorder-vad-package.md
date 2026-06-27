# Extract `@epicenter/recorder` (browser recorder + VAD capability)

**Date**: 2026-06-27
**Status**: In Progress
**Owner**: Braden
**Branch**: feat/extract-recorder-package

## One Sentence

Lift Whispering's browser audio-capture and voice-activity-detection code into a new platform-agnostic `@epicenter/recorder` package, so vocab (and future apps) can dictate without copying it or importing Whispering.

## Overview

Whispering owns all recording and VAD logic in-app. Vocab is about to want dictation. This spec extracts the runtime-portable parts (browser stream acquisition, the `MediaRecorder` recorder, the Silero VAD recorder, level smoothing) into a shared package, leaves the native Tauri/CPAL recorder and all app orchestration in Whispering, and proves the seam by giving vocab a dictation surface.

## How to read this spec

```txt
Read first:    One Sentence, Motivation, Architecture, Implementation Plan, Success Criteria
Read for why:  Research Findings, Design Decisions, Open Questions
Reference:     Call Sites, Edge Cases, References
```

## Motivation

### Current State

All recording lives inside `apps/whispering/src/lib/`:

- `services/device-stream.ts`: `getRecordingStream`, `enumerateDevices`, `cleanupRecordingStream` (pure `navigator.mediaDevices`).
- `services/recorder/types.ts`: the `RecorderService` / `RecordingSession` contract and `RecorderStopResult` (a `artifact | blob` union), `RecorderError`.
- `services/recorder/index.browser.ts`: `MediaRecorder` implementation.
- `services/recorder/index.tauri.ts`: native CPAL implementation (Rust + `tauri-specta`).
- `state/vad-recorder.svelte.ts`: VAD via `@ricky0123/vad-web` (Silero v5), one WAV blob per utterance.
- `recording-overlay/level.ts`: `foldMicLevel` RMS smoothing.

The browser and Tauri recorders are selected by a build-time `#platform/*` DI map in `apps/whispering/package.json` (lines 10-66):

```json
"#platform/recorder": {
  "tauri": "./src/lib/services/recorder/index.tauri.ts",
  "default": "./src/lib/services/recorder/index.browser.ts"
}
```

Vocab has **no** recording code at all: `apps/vocab/src/lib/state/` contains only `inference-connections.svelte.ts`.

### Problems

1. **No reuse path**: vocab cannot get dictation without copying Whispering's recorder, and apps must never import each other.
2. **VAD is the hard part and is locked in one app**: building VAD well (Silero model, worklet, silence thresholds) is non-trivial; vocab will need exactly this and would otherwise reimplement it.
3. **The capability is tangled with app glue**: settings reads, the dictation pill, sound effects, analytics, and the `recordings` table sit next to the reusable core, so the boundary is not yet drawn.

### Desired State

A `@epicenter/recorder` package exposes the portable capability:

```ts
import {
  createBrowserRecorder,
  createVadRecorder,
  getRecordingStream,
  enumerateDevices,
  foldMicLevel,
} from '@epicenter/recorder';
```

Whispering keeps its native recorder behind its own platform map; vocab uses the package directly (no Tauri, no seam). The package hands back a `Blob` plus level/state callbacks and knows nothing about transcription, tables, or settings.

## Research Findings

### The two seams are different (the central finding)

| Piece | Platform split? | Why |
| --- | --- | --- |
| Manual recorder | Yes (browser `MediaRecorder` vs Tauri CPAL/Rust) | Native capture is a different implementation, generated `tauri-specta` commands, durable WAV on disk |
| VAD | **No** | `@ricky0123/vad-web` runs in the browser, and on desktop it still runs inside the Tauri webview via `getUserMedia`. One implementation, all platforms. |

So VAD extracts as plain shared code with no seam; the manual recorder extracts as an interface plus a browser implementation, with the native implementation staying in the app.

### What is reusable vs app glue

```txt
REUSABLE (extract):
  device-stream.ts           pure navigator.mediaDevices
  recorder/types.ts          the contract
  recorder/index.browser.ts  MediaRecorder impl
  vad-recorder.svelte.ts     Silero VAD (minus 2 app ties)
  recording-overlay/level.ts foldMicLevel

APP GLUE (stays in Whispering):
  recorder/index.tauri.ts    native CPAL (Rust, tauri-specta)
  manual-recorder-config.*   settings-keyed device config
  operations/recording.ts    pill, sounds, analytics, device-fallback toasts
  operations/pipeline.ts     recordings table write, blob save, transcribe, transform, delivery
```

### VAD's two ties to Whispering (must become parameters)

1. Reads `deviceConfig.get('recording.navigator.deviceId')` directly (`vad-recorder.svelte.ts:143`).
2. Uses `defineQuery` from `$lib/rpc/client` for device enumeration.

### No existing audio package

Current `packages/*`: agent-protocol, app-shell, auth, chat, cli, client, constants, field, filesystem, identity, matter-core, server, skills, svelte-utils, sync, ui, vite-config, workspace. None touch audio. This is a genuinely new package.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Native recorder placement | 2 coherence | Tauri/CPAL stays in Whispering | Not runtime-portable (Rust + `tauri-specta`); no second Tauri consumer; follows the existing `#platform/*` "app owns native" pattern |
| VAD platform seam | 1 evidence | None; single browser impl | Verified `@ricky0123/vad-web` runs in the webview on desktop; no Tauri VAD path exists |
| `RecorderStopResult` union | 2 coherence | Keep `artifact \| blob` union in the package | It is the shared contract both impls satisfy; `artifact` fields (`id`, `durationMs`, `byteLength`) are plain and portable |
| Config injection | 2 coherence | `deviceId` and `assetBaseUrl` are parameters | Kills the `deviceConfig` coupling; the package reads no app store |
| Device enumeration | 2 coherence | Package exposes plain `enumerateDevices()`; apps wrap in their own query layer | Removes the `$lib/rpc/client` dependency |
| Framework core | 3 taste | Callback/`Result` core; `/svelte` reactive wrapper deferred | Keep the core portable; both consumers are Svelte, so a wrapper is shippable later only if duplication appears |
| `manual-recorder.svelte.ts` | 3 keep | Stays in Whispering for now | Thin orchestration over the service. Revisit when: vocab's own reactive wrapper mirrors it. |
| New ADR | 2 coherence | None required | Applies the existing `#platform/*` DI pattern and the established extract-on-second-consumer norm; introduces no new durable contract |
| Package name | 3 taste | `@epicenter/recorder` | Reads as the capability. See Open Questions for `@epicenter/audio` alternative. |

## Architecture

### Package surface

```txt
@epicenter/recorder                         (extends tsconfig.dom.json)
  index.ts
    getRecordingStream / enumerateDevices / cleanupRecordingStream
    createBrowserRecorder(opts): RecorderService          // MediaRecorder
    createVadRecorder({ assetBaseUrl, deviceId? }): VadRecorder   // Silero v5
    foldMicLevel(prev, rawRms): number
    types: RecorderService, RecordingSession, RecorderStopResult, RecorderError
  /vad/  (static assets: ONNX model + onnxruntime wasm)
  /svelte  (deferred) reactive .svelte.ts wrappers
  deps: wellcrafted (catalog), @ricky0123/vad-web; svelte peer only if /svelte ships
```

### The four seams

```txt
1. Platform (portability test): runtime-portable browser code -> package;
   native (Rust/CPAL, tauri-specta, overlay window) -> app.
2. Capability vs glue: package returns a Blob + level/state callbacks;
   it knows nothing about tables, transcription, settings, sounds, analytics.
3. Config injection: deviceId + assetBaseUrl passed in; package reads no app store.
4. Framework: callback/Result core; optional /svelte runes wrapper, not load-bearing.
```

### Platform DI after extraction (Whispering keeps the map, repoints `default`)

```txt
#platform/recorder:
  tauri   -> apps/whispering/.../recorder/index.tauri.ts   (unchanged, native)
  default -> @epicenter/recorder  createBrowserRecorder     (now from package)

vocab: imports createBrowserRecorder / createVadRecorder directly. No seam.
```

## Call Sites: before and after

### 1. Whispering device-stream import (Wave 1)

**Before** (`apps/whispering/src/lib/services/recorder/index.browser.ts`):

```ts
import { getRecordingStream, cleanupRecordingStream } from '../device-stream';
```

**After**:

```ts
import { getRecordingStream, cleanupRecordingStream } from '@epicenter/recorder';
```

### 2. VAD device coupling (Wave 3)

**Before** (`apps/whispering/src/lib/state/vad-recorder.svelte.ts:143`):

```ts
const deviceId = deviceConfig.get('recording.navigator.deviceId');
```

**After** (in package; deviceId is a parameter):

```ts
// caller (Whispering) passes it in:
vad.startActiveListening({ deviceId: deviceConfig.get('recording.navigator.deviceId'), onSpeechEnd, /* ... */ });
```

**Semantic shift to flag**: the package no longer reads any settings store. Every caller must supply `deviceId` (or omit it for the default device).

### 3. Vocab dictation (Wave 4, new code)

**After** (`apps/vocab/src/lib/state/dictation.svelte.ts`, new):

```ts
import { createVadRecorder } from '@epicenter/recorder';
import { transcribe } from '@epicenter/client';
// record -> onSpeechEnd(blob) -> transcribe(blob, connection, { model, language }) -> append to chat input
```

## Implementation Plan

Each wave is one independently-green commit (`bun typecheck` clean repo-wide). Waves 1-3 are pure moves with no behavior change; Wave 4 is the payoff feature.

### Phase 1: Scaffold + pure primitives

- [x] **1.1** Create `packages/recorder` with house boilerplate, extend `tsconfig.dom.json`, add to root catalogs as needed, `bun install` at root.
- [x] **1.2** Move `device-stream.ts` and `recording-overlay/level.ts` into the package; export from `index.ts`. (Also moved the device-identity types and `WHISPER_RECOMMENDED_MEDIA_TRACK_CONSTRAINTS` that `device-stream` depends on; see note below.)
- [x] **1.3** Repoint Whispering imports to `@epicenter/recorder`; delete the moved in-app files.
- [x] **1.4** `bun typecheck` green repo-wide; smoke Whispering recording.

### Phase 2: Recorder interface + browser impl

- [x] **2.1** Move `recorder/types.ts` (keep the `artifact | blob` union) into the package as `recorder.ts`. The `RecordingArtifact` shape is now a plain portable type; the native tauri-specta struct satisfies it structurally. `RecordingState` (was `WhisperingRecordingState`) and the browser stream-error categorizer move too.
- [x] **2.2** Move `recorder/index.browser.ts` into the package as `createBrowserRecorder` (`browser-recorder.ts`), folding in `TIMESLICE_MS`.
- [x] **2.3** Whispering's `#platform/recorder` `default` keeps pointing at a tiny in-app `index.browser.ts` adapter that instantiates `createBrowserRecorder()` as `ManualRecorderLive` (the name the Tauri branch also exports); `tauri` stays on the local native impl.
- [x] **2.4** `bun typecheck` green repo-wide (both Whispering web + Tauri tsconfigs); smoke both browser and Tauri recording.

### Phase 3: VAD + decouplings + assets

- [ ] **3.1** Move `vad-recorder.svelte.ts` into the package as `createVadRecorder` (callback core).
- [ ] **3.2** Replace the `deviceConfig.get(...)` read with a `deviceId` parameter.
- [ ] **3.3** Replace `defineQuery`-based enumeration with the package's plain `enumerateDevices()`; re-wrap in Whispering's query layer at the call site.
- [ ] **3.4** Move the Silero assets into the package; expose `assetBaseUrl` (default `/vad/`); document the static-copy step (or ship a copy script).
- [ ] **3.5** `bun typecheck`; smoke Whispering VAD recording.

### Phase 4: Vocab consumes it (payoff)

- [ ] **4.1** Add a vocab dictation surface (button + `createVadRecorder` or push-to-talk via `createBrowserRecorder`).
- [ ] **4.2** Wire `transcribe()` from `@epicenter/client`; drop the result into the chat input.
- [ ] **4.3** Serve the VAD assets from vocab; read a transcription connection from vocab's own config (vault is out of scope here).
- [ ] **4.4** `bun typecheck`; smoke vocab dictation end to end.

## Edge Cases

### VAD asset serving across apps

`@ricky0123/vad-web` loads its ONNX model and onnxruntime wasm from a base path. Each consuming app must serve them. The package ships the assets and exposes `assetBaseUrl`; without the copy step, VAD fails to initialize at runtime (not at typecheck), so this is the most likely silent break.

### Tauri device enumeration is separate

The browser `enumerateDevices()` (navigator) is for the browser and VAD paths. Whispering's Tauri manual recorder enumerates devices via Rust/CPAL and keeps its own path. Do not try to unify them.

### `RecorderStopResult.artifact` is Tauri-only

The browser impl never returns the `artifact` variant. The union stays in the package as the contract; browser-only callers (vocab) can narrow to `blob`.

### Reactivity and disposal

The recorders use Svelte runes and need explicit teardown. The core exposes explicit `stop()` / dispose; with the `/svelte` wrapper deferred, vocab writes its own thin runes wrapper.

### Browser `mimeType` variance

The browser recorder picks a supported `mimeType` from a priority list via `MediaRecorder.isTypeSupported()` (Safari differs). Carry the existing list over verbatim; do not simplify it during the move.

## Open Questions

1. **Package name: `@epicenter/recorder` vs `@epicenter/audio`?**
   - Recorder is narrower and matches today's scope; audio is broader if playback/processing later joins.
   - **Recommendation**: `@epicenter/recorder` now; rename only if scope genuinely broadens.

2. **Ship the `/svelte` reactive wrapper now or defer?**
   - **Recommendation**: defer. Let vocab write its own thin wrapper; extract a shared one only if it duplicates Whispering's.

3. **Asset shipping: documented copy step vs a Vite plugin?**
   - **Recommendation**: start with a copy script + docs; promote to a small Vite plugin if a third consumer appears.

4. **Extract a generic reactive manual-recorder state machine?**
   - **Recommendation**: defer until vocab's needs prove it is duplicated.

## Success Criteria

- [ ] `@epicenter/recorder` exists; `bun typecheck` is clean repo-wide.
- [ ] Whispering browser recording, Tauri recording, and VAD all behave identically (manual smoke).
- [ ] Whispering imports recorder primitives from the package; no moved files remain in-app (straggler sweep).
- [ ] Vocab has a working dictation surface using the package + `transcribe()`, with text landing in the chat input.
- [ ] VAD assets are served by both Whispering and vocab.

## References

- `apps/whispering/src/lib/services/device-stream.ts` - moves in Wave 1
- `apps/whispering/src/lib/services/recorder/types.ts` - the contract, Wave 2
- `apps/whispering/src/lib/services/recorder/index.browser.ts` - browser impl, Wave 2
- `apps/whispering/src/lib/services/recorder/index.tauri.ts` - native impl, stays
- `apps/whispering/src/lib/state/vad-recorder.svelte.ts` - VAD, Wave 3 (decouple `:143`)
- `apps/whispering/src/lib/recording-overlay/level.ts` - `foldMicLevel`, Wave 1
- `apps/whispering/package.json` (lines 10-66) - `#platform/*` DI map to repoint
- `apps/whispering/src/lib/operations/recording.ts`, `pipeline.ts` - app glue, stays
- `packages/client/src/transcribe.ts` - `transcribe()` vocab will call in Wave 4
- `apps/vocab/src/lib/state/inference-connections.svelte.ts` - vocab's only state today
- Package boilerplate: `monorepo` skill; tier: `tsconfig.dom.json`
