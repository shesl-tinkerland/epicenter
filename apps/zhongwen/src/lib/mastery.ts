import type { Vocabulary } from '@epicenter/zhongwen';

/**
 * Human labels for the self-reported comfort ladder (0 new, 1 learning, 2
 * known). Shared by the Words list and the reflection sheet so the two surfaces
 * never drift on what a mastery value is called.
 */
export const MASTERY_LABELS: Record<Vocabulary['mastery'], string> = {
	0: 'New',
	1: 'Learning',
	2: 'Known',
};
