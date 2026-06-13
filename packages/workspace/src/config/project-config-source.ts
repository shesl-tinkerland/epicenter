export const PROJECT_CONFIG_FILENAME = 'epicenter.config.ts';

export const DEFAULT_PROJECT_CONFIG_SOURCE = `// Default-export your app's Mount. One Epicenter folder is one mount. Example:
//
//   import { fuji } from '@epicenter/fuji/project';
//
//   export default fuji();
//
// Until you add one, \`epicenter daemon up\` reports that this file must
// default-export a Mount.
`;
