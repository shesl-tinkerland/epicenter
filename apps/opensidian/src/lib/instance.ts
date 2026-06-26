/**
 * Opensidian's instance setting: which Epicenter star this install talks to. The
 * logic is shared (see `@epicenter/app-shell/instance-setting`); this binds it to
 * Opensidian's storage key and hosted default origin. `$platform/auth` reads it
 * once at module load; the settings modal reads and writes it.
 */

import { createInstanceSetting } from '@epicenter/app-shell/instance-setting';
import { APP_URLS } from '@epicenter/constants/vite';

export const instanceSetting = createInstanceSetting({
	storageKey: 'opensidian.instance',
	defaultBaseURL: APP_URLS.API,
});
