<script lang="ts">
	import TextPreviewDialog from '$lib/components/copyable/TextPreviewDialog.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';

	/**
	 * A domain-specific wrapper around TextPreviewDialog for displaying transcript content.
	 *
	 * This component ensures consistent presentation of transcripts across the application
	 * by automatically setting the correct title, label, and transition ID pattern.
	 *
	 * @example
	 * ```svelte
	 * <TranscriptDialog
	 *   recordingId={recording.id}
 *   transcript={recording.transcript}
	 *   rows={1}
	 * />
	 * ```
	 *
	 * @example
	 * ```svelte
	 * <!-- With loading state -->
	 * <TranscriptDialog
	 *   recordingId={recording.id}
 *   transcript="..."
	 *   loading={true}
	 * />
	 * ```
	 *
	 * @example
	 * ```svelte
	 * <!-- With delete button -->
	 * <TranscriptDialog
	 *   recordingId={recording.id}
 *   transcript={recording.transcript}
	 *   onDelete={() => handleDelete(recording)}
	 * />
	 * ```
	 */
	let {
		/** The ID of the recording whose transcript is being displayed */
		recordingId,
		/** The transcript content to display */
		transcript,
		/** Number of rows for the preview textarea (default: 2) */
		rows = 2,
		/** Whether the dialog trigger is disabled */
		disabled = false,
		/** Whether to show a loading spinner instead of copy button */
		loading = false,
		/** Optional callback to delete the recording. When provided, a delete button appears in the dialog footer. */
		onDelete,
	}: {
		recordingId: string;
		transcript: string;
		rows?: number;
		disabled?: boolean;
		loading?: boolean;
		onDelete?: () => void;
	} = $props();
</script>

<TextPreviewDialog
	id={viewTransition.recording(recordingId).transcript}
	title="Transcript"
	label="transcript"
	text={transcript}
	{rows}
	{disabled}
	{loading}
	{onDelete}
/>
