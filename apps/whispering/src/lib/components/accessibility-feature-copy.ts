/**
 * Terse per-feature copy for the two Tier-1 features that sit behind the one
 * macOS Accessibility grant: Fn push-to-talk and paste-back. The home notice
 * (`DictationCapabilityNotice`) only teases these features in a one-line banner
 * and defers the detail to the guide dialog; these strings are the short inline
 * form for the settings surfaces that annotate a single feature in place.
 *
 * The shortcut recorder row reads `pushToTalk`; the auto-paste annotation reads
 * `pasteBack` followed by the shared `clipboardFallback` "you don't lose
 * anything" line, kept here so that promise stays worded identically wherever a
 * surface spells it out.
 */

/** Shared closing line for surfaces that spell out the clipboard fallback. */
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
