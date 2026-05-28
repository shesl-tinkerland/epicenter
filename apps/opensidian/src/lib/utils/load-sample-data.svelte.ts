import { toast } from '@epicenter/ui/sonner';
import type { OpensidianBrowser } from 'opensidian/browser';
import { extractErrorMessage } from 'wellcrafted/error';

export function createSampleDataLoader(workspace: OpensidianBrowser) {
	let seeding = $state(false);

	return {
		get seeding() {
			return seeding;
		},
		async load() {
			seeding = true;
			try {
				await workspace.fs.mkdir('/docs');
				await workspace.fs.mkdir('/src');
				await workspace.fs.mkdir('/src/utils');
				await workspace.fs.writeFile(
					'/README.md',
					'# FS Explorer\n\nA demo app for the Epicenter filesystem package.\n',
				);
				await workspace.fs.writeFile(
					'/docs/api.md',
					'# API Reference\n\n## YjsFileSystem\n\nThe main filesystem class.\n\n### Methods\n\n- `writeFile(path, content)`: Create or overwrite a file\n- `mkdir(path)`: Create a directory\n- `rm(path, opts)`: Remove a file or directory\n- `mv(from, to)`: Move or rename\n',
				);
				await workspace.fs.writeFile(
					'/docs/guide.md',
					'# Getting Started\n\n## Installation\n\n```bash\nbun add @epicenter/filesystem\n```\n\n## Quick Start\n\nCreate a binding and filesystem instance, then use familiar path-based APIs.\n',
				);
				await workspace.fs.writeFile(
					'/src/index.ts',
					'import { YjsFileSystem } from "@epicenter/filesystem";\n\nexport function createApp() {\n  console.log("FS Explorer initialized");\n}\n',
				);
				await workspace.fs.writeFile(
					'/src/utils/helpers.ts',
					'/** Format a file size in bytes to a human-readable string. */\nexport function formatBytes(bytes: number): string {\n  if (bytes === 0) return "0 B";\n  const k = 1024;\n  const sizes = ["B", "KB", "MB", "GB"];\n  const i = Math.floor(Math.log(bytes) / Math.log(k));\n  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;\n}\n',
				);
				toast.success('Loaded sample data');
			} catch (err) {
				toast.error('Failed to load sample data', {
					description: extractErrorMessage(err),
				});
				console.error(err);
			} finally {
				seeding = false;
			}
		},
	};
}
