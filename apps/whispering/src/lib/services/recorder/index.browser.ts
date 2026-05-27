import { NavigatorRecorderServiceLive } from './navigator';
import type { ProbeActiveCpalRecording, RecorderService } from './types';

export type { RecorderError, RecorderService, RecordingSession } from './types';

export { NavigatorRecorderServiceLive };

/**
 * CPAL is Tauri-only. On web both bindings are `null`, so consumers can
 * still import them without a build-time conditional. Callers null-check
 * before use; this is the runtime-DI seam inside the build-time-DI
 * envelope (settings.recording.method = 'cpal' is only ever true inside
 * a Tauri bundle, where `index.tauri.ts` overrides these to the real
 * implementations).
 */
export const CpalRecorderServiceLive: RecorderService | null = null;
export const probeActiveCpalRecording: ProbeActiveCpalRecording | null = null;
