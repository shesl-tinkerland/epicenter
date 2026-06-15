import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { report } from '$lib/report';
import { services } from '$lib/services';
import { type Recording, recordings } from '$lib/state/recordings.svelte';

export function deleteRecordingsWithConfirmation(
	toDelete: Recording | Recording[],
	{ onSuccess }: { onSuccess?: () => void } = {},
) {
	const arr = Array.isArray(toDelete) ? toDelete : [toDelete];
	const isSingle = arr.length === 1;
	const noun = isSingle ? 'recording' : 'recordings';

	confirmationDialog.open({
		title: `Delete ${noun}`,
		description: `Are you sure you want to delete ${isSingle ? 'this' : 'these'} ${noun}?`,
		confirm: { text: 'Delete', variant: 'destructive' },
		onConfirm: () => {
			for (const recording of arr) {
				// Revoke the playback URL before deleting the row so it cannot leak.
				services.blobs.audio.revokeUrl(recording.id);
				recordings.delete(recording.id);
			}
			report.success({
				title: `Deleted ${noun}!`,
				description: `Your ${noun} ${isSingle ? 'has' : 'have'} been deleted.`,
			});
			onSuccess?.();
		},
	});
}
