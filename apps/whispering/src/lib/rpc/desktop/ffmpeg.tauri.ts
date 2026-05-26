import { Ok } from 'wellcrafted/result';
import { FfmpegServiceLive } from '$lib/tauri/ffmpeg';
import { defineQuery } from '$lib/rpc/client';
import { WhisperingErr } from '$lib/result';

export const ffmpeg = {
	checkFfmpegInstalled: defineQuery({
		queryKey: ['ffmpeg.checkInstalled'],
		queryFn: async () => {
			const { data, error } = await FfmpegServiceLive.checkInstalled();
			if (error) {
				return WhisperingErr({
					title: '❌ Error checking FFmpeg installation',
					serviceError: error,
				});
			}
			return Ok(data);
		},
	}),
};
