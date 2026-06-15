import { type DocGuid, docGuid } from '@epicenter/workspace';

export function referenceContentDocGuid({
	workspaceId,
	referenceId,
}: {
	workspaceId: string;
	referenceId: string;
}): DocGuid {
	return docGuid({
		workspaceId,
		collection: 'references',
		rowId: referenceId,
		field: 'content',
	});
}
