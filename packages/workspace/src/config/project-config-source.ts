export const PROJECT_CONFIG_FILENAME = 'epicenter.config.ts';

export const DEFAULT_PROJECT_CONFIG_SOURCE = `// Default-export a Mount (single-mount) or a Mount[] (multi-mount).
// Example:
//
//   import { fuji } from '@epicenter/fuji/project';
//   export default fuji();
//
//   // or, for multiple apps in one project:
//   import { fuji } from '@epicenter/fuji/project';
//   import { notes } from '@epicenter/honeycrisp/project';
//   export default [fuji(), notes()];

export default [];
`;
