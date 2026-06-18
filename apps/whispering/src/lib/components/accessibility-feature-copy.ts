/**
 * Terse per-feature copy for the two Tier-1 features that sit behind the one
 * macOS Accessibility grant: Fn push-to-talk and paste-back. The home notice
 * (`DictationCapabilityNotice`) pitches both features together in a richer,
 * upgrade-flavored register; these strings are the short inline form for the
 * surfaces that annotate a single feature in place.
 *
 * What earns the module is the shared `clipboardFallback` line: the home notice
 * (`DictationCapabilityNotice`) and the auto-paste annotation both render it, so
 * the "you don't lose anything" promise stays worded identically. The shortcut
 * recorder row reads `pushToTalk`; the auto-paste annotation reads `pasteBack`.
 */

/** Shared closing line, matched to the home notice for consistency. */
export const clipboardFallback =
	'Without it, transcripts still go to your clipboard.';

/**
 * Fn push-to-talk (press to record, release to stop), worded as the recorder
 * row's button label: a recorder there would capture nothing without the grant.
 */
export const pushToTalk = 'Grant Accessibility to record';

/**
 * Paste-back (transcripts land where you're typing), worded as the auto-paste
 * toggle's inline locked hint.
 */
export const pasteBack = 'Pasting at your cursor needs macOS Accessibility.';
