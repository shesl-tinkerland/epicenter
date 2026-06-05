/**
 * Browser runtime client for Whispering.
 *
 * Picks the active doc (local or synced) at boot via `openActiveWhispering`,
 * then layers the one browser-specific action: native markdown export returns a
 * typed unsupported error here instead of importing Tauri plugins into the web
 * bundle. The `whispering` singleton it exports is consumed everywhere through
 * the `#platform/whispering` seam.
 */

import {
	defineActions,
	defineMutation,
	defineWorkspace,
} from '@epicenter/workspace';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import { openActiveWhispering } from './whispering.active';

const RecordingMarkdownExportError = defineErrors({
	Unsupported: () => ({
		message: 'Recording markdown export is only available in the desktop app.',
	}),
});
type RecordingMarkdownExportError = InferErrors<
	typeof RecordingMarkdownExportError
>;

type RecordingMarkdownExportResult =
	| {
			status: 'cancelled';
	  }
	| {
			status: 'exported';
			dir: string;
			written: number;
	  };

const { workspace, whenReady, collaboration } = openActiveWhispering();

export const whispering = defineWorkspace({
	...workspace,
	actions: defineActions({
		...workspace.actions,
		recordings_export_markdown: defineMutation({
			title: 'Export recording markdown',
			description: 'Export current recordings as markdown files',
			handler: async (): Promise<
				Result<RecordingMarkdownExportResult, RecordingMarkdownExportError>
			> => RecordingMarkdownExportError.Unsupported(),
		}),
	}),
	whenReady,
	collaboration,
});
