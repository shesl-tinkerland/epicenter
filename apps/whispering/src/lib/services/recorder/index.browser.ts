import {
	createBrowserRecorder,
	type NavigatorRecordingParams,
	type RecorderService,
} from '@epicenter/recorder';

/**
 * Browser branch of the `#platform/recorder` seam. The MediaRecorder
 * implementation lives in `@epicenter/recorder`; this module just instantiates
 * it under the `ManualRecorderLive` name the seam's Tauri branch also exports,
 * so `manual-recorder.svelte.ts` consumes one shape regardless of platform.
 */
export const ManualRecorderLive: RecorderService<NavigatorRecordingParams> =
	createBrowserRecorder();
