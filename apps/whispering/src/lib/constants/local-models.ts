/**
 * Download catalogs and shapes for the three local transcription engines.
 *
 * The Rust side (`transcribe_recording`) accepts a single discriminated
 * `TranscribeRequest` per call; this file is the JS-side source of truth
 * for the *download* metadata (URLs, sizes, directory naming) and the
 * type shapes the settings UI binds against. Engine-specific runtime
 * dispatch lives in `$lib/operations/transcribe.ts`.
 */

/**
 * Supported languages for Moonshine models.
 *
 * Moonshine supports 8 languages with varying model availability:
 * - tiny variants: en, ar, zh, ja, ko, uk, vi (quantized versions available)
 * - base variants: en, es (quantized versions available)
 *
 * Currently only English models are exposed. Other languages can be enabled
 * by uncommenting below once we're ready to support them.
 */
const MOONSHINE_LANGUAGES = [
	'en',
	// 'ar',
	// 'zh',
	// 'ja',
	// 'ko',
	// 'es',
	// 'uk',
	// 'vi',
] as const;

type MoonshineLanguage = (typeof MOONSHINE_LANGUAGES)[number];

/**
 * Moonshine architecture variants. Determines layer count and hidden
 * dimensions; transcribe-rs needs this to load the ONNX files since they
 * don't self-describe their architecture.
 *
 * Variant inference from the directory name lives in Rust
 * (`transcription/model_cache.rs::parse_moonshine_variant`), since that
 * is the only consumer and the wire format is owned by the loader.
 */
const MOONSHINE_VARIANTS = ['tiny', 'base'] as const;

type MoonshineVariant = (typeof MOONSHINE_VARIANTS)[number];

/**
 * Base configuration for a local AI model that can be downloaded and used
 * for transcription.
 */
type BaseModelConfig = {
	/** Unique identifier for the model */
	id: string;
	/** Display name for the model */
	name: string;
	/** Brief description of the model's capabilities */
	description: string;
	/** Human-readable file size (e.g., "850 MB", "1.5 GB") */
	size: string;
	/** Exact size in bytes for progress tracking */
	sizeBytes: number;
};

/** Whisper models are a single .bin file. */
type WhisperModelConfig = BaseModelConfig & {
	engine: 'whispercpp';
	file: {
		url: string;
		filename: string;
	};
};

/** Parakeet models are multiple ONNX files in a directory. */
type ParakeetModelConfig = BaseModelConfig & {
	engine: 'parakeet';
	directoryName: string;
	files: Array<{
		url: string;
		filename: string;
		sizeBytes: number;
	}>;
};

/**
 * Moonshine models are encoder/decoder ONNX files in a directory.
 *
 * Moonshine's ONNX files don't self-describe their architecture (unlike
 * Whisper .bin files which contain metadata, or Parakeet which includes
 * config.json). The variant ("tiny" or "base") tells transcribe-rs the
 * layer count and hidden dimensions needed to load the model.
 *
 * Rather than storing the variant separately, we encode it in the
 * `directoryName` (e.g. "moonshine-tiny-en") and parse it back out in Rust
 * (`transcription/model_cache.rs::parse_moonshine_variant`). This avoids
 * redundant metadata while keeping our download configs simple.
 *
 * Variant architecture:
 * - "tiny": 6 layers, head_dim=36 (~30 MB quantized)
 * - "base": 8 layers, head_dim=52 (~65 MB quantized)
 */
type MoonshineModelConfig = BaseModelConfig & {
	engine: 'moonshine';
	language: MoonshineLanguage;
	directoryName: `moonshine-${MoonshineVariant}-${MoonshineLanguage}`;
	files: Array<{
		url: string;
		filename: string;
		sizeBytes: number;
	}>;
};

export type LocalModelConfig =
	| WhisperModelConfig
	| ParakeetModelConfig
	| MoonshineModelConfig;

const WHISPER_SMALL = {
	id: 'small',
	name: 'Small',
	description: 'Fast, good accuracy',
	size: '488 MB',
	sizeBytes: 487_601_967,
	engine: 'whispercpp',
	file: {
		url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
		filename: 'ggml-small.bin',
	},
} as const satisfies WhisperModelConfig;

/**
 * Pre-built Whisper models available for download from Hugging Face.
 * These are ggml-format models compatible with whisper.cpp.
 */
export const WHISPER_MODELS = [
	{
		id: 'tiny',
		name: 'Tiny',
		description: 'Fastest, basic accuracy',
		size: '78 MB',
		sizeBytes: 77_691_713,
		engine: 'whispercpp',
		file: {
			url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
			filename: 'ggml-tiny.bin',
		},
	},
	WHISPER_SMALL,
	{
		id: 'medium',
		name: 'Medium',
		description: 'Balanced speed & accuracy',
		size: '1.5 GB',
		sizeBytes: 1_533_763_059,
		engine: 'whispercpp',
		file: {
			url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
			filename: 'ggml-medium.bin',
		},
	},
	{
		id: 'large-v3-turbo',
		name: 'Large v3 Turbo',
		description: 'Best accuracy, slower',
		size: '1.6 GB',
		sizeBytes: 1_624_555_275,
		engine: 'whispercpp',
		file: {
			url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
			filename: 'ggml-large-v3-turbo.bin',
		},
	},
] as const satisfies readonly WhisperModelConfig[];

const PARAKEET_TDT_06B_V3_INT8 = {
	id: 'parakeet-tdt-0.6b-v3-int8',
	name: 'Parakeet TDT 0.6B v3 (INT8)',
	description: 'Fast and accurate NVIDIA NeMo model',
	size: '~670 MB',
	sizeBytes: 670_619_803,
	engine: 'parakeet',
	directoryName: 'parakeet-tdt-0.6b-v3-int8',
	files: [
		{
			url: 'https://github.com/EpicenterHQ/epicenter/releases/download/models/parakeet-tdt-0.6b-v3-int8/config.json',
			filename: 'config.json',
			sizeBytes: 97,
		},
		{
			url: 'https://github.com/EpicenterHQ/epicenter/releases/download/models/parakeet-tdt-0.6b-v3-int8/decoder_joint-model.int8.onnx',
			filename: 'decoder_joint-model.int8.onnx',
			sizeBytes: 18_202_004,
		},
		{
			url: 'https://github.com/EpicenterHQ/epicenter/releases/download/models/parakeet-tdt-0.6b-v3-int8/encoder-model.int8.onnx',
			filename: 'encoder-model.int8.onnx',
			sizeBytes: 652_183_999,
		},
		{
			url: 'https://github.com/EpicenterHQ/epicenter/releases/download/models/parakeet-tdt-0.6b-v3-int8/nemo128.onnx',
			filename: 'nemo128.onnx',
			sizeBytes: 139_764,
		},
		{
			url: 'https://github.com/EpicenterHQ/epicenter/releases/download/models/parakeet-tdt-0.6b-v3-int8/vocab.txt',
			filename: 'vocab.txt',
			sizeBytes: 93_939,
		},
	],
} as const satisfies ParakeetModelConfig;

/**
 * Pre-built Parakeet models available for download from GitHub releases.
 * These are NVIDIA NeMo models consisting of multiple ONNX files.
 */
export const PARAKEET_MODELS = [
	PARAKEET_TDT_06B_V3_INT8,
] as const satisfies readonly ParakeetModelConfig[];

/**
 * Pre-built Moonshine models available for download from HuggingFace.
 * These are ONNX models using encoder-decoder architecture with KV caching.
 *
 * Model directories MUST follow the format `moonshine-{variant}-{lang}`
 * because Rust's `parse_moonshine_variant` reads the variant out of the
 * directory name at transcribe time.
 *
 * Note: Language-specific models (ar, zh, ja, ko, uk, vi, es) exist but only
 * have float versions available. We provide quantized English models for now
 * since they offer the best size/performance tradeoff.
 */
const HF_BASE = 'https://huggingface.co/UsefulSensors/moonshine/resolve/main';

const MOONSHINE_BASE_EN = {
	id: 'moonshine-base-en',
	name: 'Moonshine Base (English)',
	description: 'Higher accuracy English transcription',
	size: '~65 MB',
	sizeBytes: 64_997_467,
	engine: 'moonshine',
	language: 'en',
	directoryName: 'moonshine-base-en',
	files: [
		{
			url: `${HF_BASE}/onnx/merged/base/quantized/encoder_model.onnx`,
			filename: 'encoder_model.onnx',
			sizeBytes: 20_513_063,
		},
		{
			url: `${HF_BASE}/onnx/merged/base/quantized/decoder_model_merged.onnx`,
			filename: 'decoder_model_merged.onnx',
			sizeBytes: 42_498_870,
		},
		{
			url: `${HF_BASE}/ctranslate2/tiny/tokenizer.json`,
			filename: 'tokenizer.json',
			sizeBytes: 1_985_534,
		},
	],
} as const satisfies MoonshineModelConfig;

export const MOONSHINE_MODELS = [
	{
		id: 'moonshine-tiny-en',
		name: 'Moonshine Tiny (English)',
		description: 'Fast and efficient English transcription',
		size: '~30 MB',
		sizeBytes: 30_166_481,
		engine: 'moonshine',
		language: 'en',
		directoryName: 'moonshine-tiny-en',
		files: [
			{
				url: `${HF_BASE}/onnx/merged/tiny/quantized/encoder_model.onnx`,
				filename: 'encoder_model.onnx',
				sizeBytes: 7_937_661,
			},
			{
				url: `${HF_BASE}/onnx/merged/tiny/quantized/decoder_model_merged.onnx`,
				filename: 'decoder_model_merged.onnx',
				sizeBytes: 20_243_286,
			},
			{
				url: `${HF_BASE}/ctranslate2/tiny/tokenizer.json`,
				filename: 'tokenizer.json',
				sizeBytes: 1_985_534,
			},
		],
	},
	MOONSHINE_BASE_EN,
] as const satisfies readonly MoonshineModelConfig[];

/**
 * Each engine's default download: the model the settings UI builds its
 * primary action around. The mapped type guarantees every engine names
 * exactly one recommendation and that it belongs to that engine.
 */
export const RECOMMENDED_MODELS = {
	whispercpp: WHISPER_SMALL,
	parakeet: PARAKEET_TDT_06B_V3_INT8,
	moonshine: MOONSHINE_BASE_EN,
} satisfies {
	[E in LocalModelConfig['engine']]: Extract<LocalModelConfig, { engine: E }>;
};

/**
 * The model's entry name inside its engine's models folder: the filename
 * for Whisper, the directory name for Parakeet and Moonshine. This is the
 * value settings store to mark a model active.
 */
export function modelEntryName(model: LocalModelConfig): string {
	switch (model.engine) {
		case 'whispercpp':
			return model.file.filename;
		case 'parakeet':
		case 'moonshine':
			return model.directoryName;
	}
}
