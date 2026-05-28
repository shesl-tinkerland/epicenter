import { Err, tryAsync } from 'wellcrafted/result';

export const osNotify = (title: string, body: string | undefined) => {
	void tryAsync({
		try: async () => {
			if (!('Notification' in window)) return;
			let permission = Notification.permission;
			if (permission === 'default') {
				permission = await Notification.requestPermission();
			}
			if (permission === 'granted') new Notification(title, { body });
		},
		catch: (cause) => Err(cause),
	});
};
