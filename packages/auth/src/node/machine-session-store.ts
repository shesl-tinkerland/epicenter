import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, tryAsync, type Result } from 'wellcrafted/result';
import {
	BearerSession,
	type BearerSession as BearerSessionType,
} from '../auth-types.js';

export const MachineAuthStorageError = defineErrors({
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not access machine session storage: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MachineAuthStorageError = InferErrors<
	typeof MachineAuthStorageError
>;

const machineSessionOptions = {
	service: 'epicenter.auth.session',
	name: 'current',
};

/**
 * Load the saved machine auth session from the operating system keychain.
 *
 * Corrupt blobs are logged and treated as signed-out so a schema change cannot
 * brick the CLI.
 */
export async function loadMachineSession({
	backend = Bun.secrets,
	log = createLogger('machine-session-store'),
}: {
	backend?: typeof Bun.secrets;
	log?: Logger;
} = {}): Promise<Result<BearerSessionType | null, MachineAuthStorageError>> {
	const { data: raw, error } = await tryAsync({
		try: () => backend.get(machineSessionOptions),
		catch: (cause) => MachineAuthStorageError.StorageFailed({ cause }),
	});
	if (error) return Err(error);
	if (raw === null) return Ok(null);

	try {
		return Ok(BearerSession.assert(JSON.parse(raw)));
	} catch (cause) {
		log.warn(
			MachineAuthStorageError.StorageFailed({
				cause: new Error(
					`Discarding corrupted machine session: ${extractErrorMessage(cause)}`,
					{ cause },
				),
			}),
		);
		return Ok(null);
	}
}

/**
 * Save one machine auth session in the operating system keychain.
 */
export async function saveMachineSession(
	session: BearerSessionType | null,
	{
		backend = Bun.secrets,
	}: {
		backend?: typeof Bun.secrets;
	} = {},
): Promise<Result<undefined, MachineAuthStorageError>> {
	return tryAsync({
		try: async (): Promise<undefined> => {
			if (session === null) {
				await backend.delete(machineSessionOptions);
			} else {
				await backend.set({
					...machineSessionOptions,
					value: JSON.stringify(BearerSession.assert(session)),
				});
			}
			return undefined;
		},
		catch: (cause) => MachineAuthStorageError.StorageFailed({ cause }),
	});
}
