#!/usr/bin/env bun
/**
 * Cross-platform `tauri dev` launcher.
 *
 * Every platform gets the dev identity (productName "Whispering Dev",
 * identifier so.epicenter.whispering.dev) so dev never wears production's
 * identity. macOS additionally gets a codesigning runner so the Accessibility
 * grant survives Rust rebuilds (see src-tauri/scripts/dev-codesign-runner.sh);
 * the runner shells out to `codesign`, which only exists on macOS, so it is
 * wired in there and nowhere else.
 */
import { spawn } from 'node:child_process';

const configs = ['src-tauri/tauri.dev.conf.json'];
if (process.platform === 'darwin') {
	configs.push('src-tauri/tauri.dev.macos.conf.json');
}

const args = ['tauri', 'dev'];
for (const config of configs) {
	args.push('--config', config);
}
args.push(...process.argv.slice(2));

const child = spawn('bun', args, { stdio: 'inherit' });
child.on('exit', (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
	} else {
		process.exit(code ?? 0);
	}
});
