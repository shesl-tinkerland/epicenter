import { type DocGuid, docGuid } from '@epicenter/workspace';
import type { FileId } from './ids.js';

export function fileContentDocGuid({
	workspaceId,
	fileId,
}: {
	workspaceId: string;
	fileId: FileId;
}): DocGuid {
	return docGuid({
		workspaceId,
		collection: 'files',
		rowId: fileId,
		field: 'content',
	});
}
