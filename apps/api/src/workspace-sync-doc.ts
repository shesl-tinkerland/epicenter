import type { AuthUser } from '@epicenter/auth';

const ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type AuthorizedWorkspaceSyncDoc = {
	workspaceId: string;
	appId: string;
	docId: string;
	roomName: string;
	syncDocResourceName: string;
};

type ResolveAuthorizedWorkspaceSyncDocInput = {
	user: AuthUser;
	workspaceId: string | undefined;
	appId: string | undefined;
	docId: string | undefined;
	checkWorkspaceMembership: (params: {
		userId: string;
		workspaceId: string;
	}) => Promise<boolean>;
};

type ResolveAuthorizedWorkspaceSyncDocResult =
	| { data: AuthorizedWorkspaceSyncDoc; error?: never }
	| {
			data?: never;
			error: {
				name: 'InvalidWorkspaceSyncDoc' | 'WorkspaceForbidden';
				message: string;
				status: 400 | 403;
			};
	  };

export function buildWorkspaceSyncDocRoomName(params: {
	workspaceId: string;
	appId: string;
	docId: string;
}) {
	return [
		'v1',
		'workspace',
		encodeURIComponent(params.workspaceId),
		'app',
		encodeURIComponent(params.appId),
		'doc',
		encodeURIComponent(params.docId),
	].join(':');
}

export async function resolveAuthorizedWorkspaceSyncDoc({
	user,
	workspaceId,
	appId,
	docId,
	checkWorkspaceMembership,
}: ResolveAuthorizedWorkspaceSyncDocInput): Promise<ResolveAuthorizedWorkspaceSyncDocResult> {
	if (!isValidRouteId(workspaceId)) {
		return invalid('workspaceId');
	}
	if (!isValidRouteId(appId)) {
		return invalid('appId');
	}
	if (!isValidRouteId(docId)) {
		return invalid('docId');
	}

	const isMember = await checkWorkspaceMembership({
		userId: user.id,
		workspaceId,
	});
	if (!isMember) {
		return {
			error: {
				name: 'WorkspaceForbidden',
				message: 'User is not a member of this workspace',
				status: 403,
			},
		};
	}

	const roomName = buildWorkspaceSyncDocRoomName({
		workspaceId,
		appId,
		docId,
	});

	return {
		data: {
			workspaceId,
			appId,
			docId,
			roomName,
			syncDocResourceName: `${workspaceId}/${appId}/${docId}`,
		},
	};
}

function isValidRouteId(value: string | undefined): value is string {
	return value != null && ROUTE_ID_PATTERN.test(value);
}

function invalid(param: 'workspaceId' | 'appId' | 'docId') {
	return {
		error: {
			name: 'InvalidWorkspaceSyncDoc',
			message: `Invalid ${param}`,
			status: 400,
		},
	} satisfies ResolveAuthorizedWorkspaceSyncDocResult;
}
