import { type } from 'arktype';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { HttpServiceLive } from '#platform/http';
import { getAudioExtension } from '$lib/services/transcription/utils';

const WhisperApiResponse = type({ text: 'string' }, '|', {
	error: { message: 'string' },
});

export const SpeachesError = defineErrors({
	ConnectionIssue: ({ cause }: { cause: unknown }) => ({
		message:
			'Unable to connect to the transcription service. This could be a network issue or temporary service interruption. Please try again in a moment.',
		cause,
	}),
	AuthenticationRequired: ({ cause }: { cause: unknown }) => ({
		message:
			'Your API key appears to be invalid or expired. Please update your API key in settings to continue transcribing.',
		cause,
	}),
	AccessRestricted: ({ cause }: { cause: unknown }) => ({
		message:
			"Your account doesn't have access to this feature. This may be due to plan limitations or account restrictions. Please check your account status.",
		cause,
	}),
	AudioFileTooLarge: ({ cause }: { cause: unknown }) => ({
		message:
			'Your audio file exceeds the maximum size limit (typically 25MB). Try splitting it into smaller segments or reducing the audio quality.',
		cause,
	}),
	UnsupportedFormat: ({ cause }: { cause: unknown }) => ({
		message:
			"This audio format isn't supported. Please convert your file to MP3, WAV, M4A, or another common audio format.",
		cause,
	}),
	RateLimitReached: ({
		message,
		cause,
	}: {
		message: string;
		cause: unknown;
	}) => ({
		message,
		cause,
	}),
	ServiceUnavailable: ({
		status,
		cause,
	}: {
		status: number;
		cause: unknown;
	}) => ({
		message: `The transcription service is temporarily unavailable (Error ${status}). Please try again in a few minutes.`,
		status,
		cause,
	}),
	RequestFailed: ({ status, cause }: { status: number; cause: unknown }) => ({
		message: `The request failed with error ${status}. This may be temporary - please try again. If the problem persists, please contact support.`,
		status,
		cause,
	}),
	ResponseError: ({ cause }: { cause: unknown }) => ({
		message:
			'Received an unexpected response from the transcription service. This is usually temporary - please try again.',
		cause,
	}),
	UnexpectedError: ({ cause }: { cause: unknown }) => ({
		message:
			'An unexpected error occurred during transcription. Please try again, and contact support if the issue continues.',
		cause,
	}),
	SpeachesConnectionIssue: ({ message }: { message: string }) => ({
		message,
	}),
});
export type SpeachesError = InferErrors<typeof SpeachesError>;

export const SpeachesTranscriptionServiceLive = {
	transcribe: async (
		audioBlob: Blob,
		options: {
			prompt: string;
			spokenLanguage: string;
			modelId: string;
			baseUrl: string;
		},
	): Promise<Result<string, SpeachesError>> => {
		const formData = new FormData();
		formData.append(
			'file',
			new File([audioBlob], `recording.${getAudioExtension(audioBlob.type)}`, {
				type: audioBlob.type,
			}),
		);
		formData.append('model', options.modelId);
		if (options.spokenLanguage !== 'auto') {
			formData.append('language', options.spokenLanguage);
		}
		if (options.prompt) formData.append('prompt', options.prompt);

		const { data: whisperApiResponse, error: postError } =
			await HttpServiceLive.post({
				url: `${options.baseUrl}/v1/audio/transcriptions`,
				body: formData,
				schema: WhisperApiResponse,
			});

		if (postError) {
			switch (postError.name) {
				case 'Connection': {
					return SpeachesError.ConnectionIssue({ cause: postError });
				}

				case 'Response': {
					const { status, message } = postError;

					if (status === 401) {
						return SpeachesError.AuthenticationRequired({
							cause: postError,
						});
					}

					if (status === 403) {
						return SpeachesError.AccessRestricted({ cause: postError });
					}

					if (status === 413) {
						return SpeachesError.AudioFileTooLarge({ cause: postError });
					}

					if (status === 415) {
						return SpeachesError.UnsupportedFormat({ cause: postError });
					}

					// Rate limiting
					if (status === 429) {
						return SpeachesError.RateLimitReached({
							message,
							cause: postError,
						});
					}

					if (status >= 500) {
						return SpeachesError.ServiceUnavailable({
							status,
							cause: postError,
						});
					}

					return SpeachesError.RequestFailed({
						status,
						cause: postError,
					});
				}

				case 'Parse':
					return SpeachesError.ResponseError({ cause: postError });

				default:
					return SpeachesError.UnexpectedError({ cause: postError });
			}
		}

		if ('error' in whisperApiResponse) {
			return SpeachesError.SpeachesConnectionIssue({
				message: whisperApiResponse.error.message,
			});
		}

		return Ok(whisperApiResponse.text.trim());
	},
};
