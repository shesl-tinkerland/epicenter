import type { CheckResult } from './report';

type CheckExitCode = 0 | 1 | 2;

export function exitCodeFor(result: CheckResult): CheckExitCode {
	if (result.status === 'fatal') return 2;
	return result.summary.needsAttention === 0 && result.summary.unreadable === 0
		? 0
		: 1;
}
