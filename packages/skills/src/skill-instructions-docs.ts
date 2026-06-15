import { type DocGuid, docGuid } from '@epicenter/workspace';

export function skillInstructionsDocGuid({
	workspaceId,
	skillId,
}: {
	workspaceId: string;
	skillId: string;
}): DocGuid {
	return docGuid({
		workspaceId,
		collection: 'skills',
		rowId: skillId,
		field: 'instructions',
	});
}
