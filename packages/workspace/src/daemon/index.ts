export type { DaemonRuntime, StartedMount } from '../mount/contract.js';
export {
	defineMount,
	type Mount,
	type MountContext,
} from '../mount/contract.js';
export {
	type AttachProjectInfrastructureOptions,
	attachProjectInfrastructure,
	type ProjectInfrastructure,
} from './attach-project-infrastructure.js';
