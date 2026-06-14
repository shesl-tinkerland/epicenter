# Vocab Pronunciation: STT and TTS Research (English + Mandarin)

Research sub-spec. Date: 2026-06-14. Scope: speech-to-text (STT) and text-to-speech (TTS) for a local-first language-learning app whose core feature is PRONUNCIATION GRADING of single words and short phrases in English and Mandarin Chinese, plus speak-aloud for listening practice. Target runtimes: web app and Tauri desktop.

## TL;DR verdict

Real phoneme-level and Mandarin-tone pronunciation scoring is a genuinely hard signal-processing and acoustic-modeling problem; do not build it from scratch for an MVP. Two pragmatic tiers exist. Tier 0 (ship now, fully local, free): a "STT round-trip" floor. Speak the target word, transcribe with Whisper (whisper.cpp on Tauri, transformers.js on web), and grade pass/fail by whether the transcription matches the target. This is honest as a binary "did it come out as the right word" check (Whisper's own confidence correlates R=-0.94 with transcription edit distance) but only partially tracks true human pronunciation grades (R=-0.57 in the one peer-reviewed L2 study), so present it as "recognized correctly," not as a 0 to 100 pronunciation score. For Mandarin tones specifically, Whisper round-trip is weak because Whisper happily outputs the right hanzi even when the tone is wrong; bolt on a cheap DIY tone check (extract F0 with a pitch tracker, classify the 4-tone contour shape) to get a real tone signal locally. Tier 1 (when you want a credible numeric pronunciation score with phoneme breakdown): call a cloud API. Azure Pronunciation Assessment is the best-documented for English (accuracy/fluency/completeness/prosody + IPA phoneme scores, ~$1 to $1.32/audio-hour) but it does NOT score Mandarin tones and only returns phoneme-name detail for zh-CN in the SAPI alphabet. The only turnkey API that explicitly returns a Mandarin "Tone score" is SpeechSuper (~$0.004 to $0.008 per request). Recommended MVP: local Whisper round-trip for both languages + a local F0 tone classifier for Mandarin (free, private, offline), and reserve Azure/SpeechSuper as an optional "deep feedback" upgrade behind a cloud toggle.

---

## 1. Pronunciation assessment approaches

### 1.1 Goodness of Pronunciation (GOP) and forced alignment

GOP is the classic Computer-Assisted Pronunciation Training (CAPT) metric. The pipeline:

1. Force-align the learner audio to the known reference phoneme sequence (you know what word they were asked to say). Tools: Montreal Forced Aligner (MFA, built on Kaldi) or Kaldi directly. Alignment splits the waveform into per-phoneme time segments.
2. For each aligned phoneme, compute the acoustic model's posterior probability of the intended phoneme, normalized by the max posterior over all phonemes in that frame. Low normalized posterior = the learner's segment looks unlike the target phoneme = likely mispronunciation.

Signal produced: a per-phoneme "goodness" score, aggregatable to syllable/word/utterance. This is the signal Azure and Speechace effectively productize.

Reliability and caveats (grounded in the literature):
- GOP depends on forced alignment, which is "prone to labeling and segmentation errors due to acoustic variability," and the segment-wise treatment "neglects the transitions between phonemes." Alignment errors directly degrade scoring; multiple 2021 to 2025 papers quantify this, and it is worse on children's and heavily-accented speech (exactly your L2 population).
- Newer alignment-free variants use CTC graphs to marginalize over all alignments (no hard segmentation), and logit-based GOP. These improve robustness but are research code, not a library you drop in.
- Building GOP yourself means shipping Kaldi/MFA + an acoustic model + a pronunciation lexicon per language. That is a heavy, non-trivial native dependency. Not MVP-friendly; this is the "defer" pile.

### 1.2 Whisper-logprob-based scoring

Idea: instead of GOP, lean on a general ASR model you already ship. Two flavors:

- Round-trip / transcription match (simplest): transcribe the utterance, compare to the target word. Pass if it matches.
- Forced-decoding probability: teacher-force Whisper with the reference text and read out per-token average log-probability (`avg_logprob`), or use Whisper's `logprob_threshold` (default -1.0) as a confidence gate.

Signal produced: a scalar confidence per segment/word, plus the transcription itself. Whisper also has word-level timestamps via DTW on attention (whisper-timestamped) or external forced alignment (WhisperX uses a wav2vec2 phoneme model), giving rough per-word timing if you want it.

Reliability (the honest part, from the one peer-reviewed L2 study, Ballier and Meli, NLP4CALL 2024, ISLE corpus, 23 Italian learners of English, Whisper tiny):
- Whisper's mean probability score correlates VERY strongly (Pearson R = -0.94, p < 0.005) with Levenshtein distance of the transcription to the reference text. Translation: Whisper confidence is essentially a proxy for "did it transcribe the right thing," which is what round-trip already measures.
- Whisper-derived signals correlate only PARTIALLY with the human expert proficiency grades (R = -0.57). So logprob is a decent "intelligibility / recognized-correctly" signal but a weak proxy for a graded pronunciation score.
- Practical implication: ship round-trip as a binary "recognized as the target word" check. Do NOT dress a Whisper logprob up as a calibrated 0 to 100 pronunciation grade; it will mislead learners on near-miss accents.

### 1.3 Mandarin tone assessment (the hard part)

Whisper and ASR-transcription approaches are weak here: a tone error often still yields the correct hanzi in context (the language model "fixes" it), so round-trip cannot tell tone 2 from tone 3. Tone needs explicit pitch (F0) analysis. The four tones are pitch-contour shapes over the syllable:

- Tone 1: high, level (flat F0).
- Tone 2: rising (low to high).
- Tone 3: dipping (fall then rise).
- Tone 4: falling (high to low, fast).

State of the art (Nature Scientific Reports 2025, ResNet-18 Siamese network for L2 Mandarin tone scoring) and the broader literature converge on a clean recipe:
1. Extract F0 per syllable. Sources used in papers: WORLD vocoder, Praat autocorrelation, or CREPE/pYIN.
2. Smooth the contour (Local Weighted Regression / LOESS) to kill octave-jump outliers.
3. Normalize to a speaker-independent 5-level tone scale (the "T-value" method) so a low-voiced and high-voiced speaker map onto the same scale. This is the key step that makes the contour comparable across users.
4. Classify or compare. Options range from simple template/DTW comparison of the normalized contour against the canonical tone shape, up to a CNN/ResNet on a 40-dim F0 vector (or a 40x50 contour image). The Nature paper's ResNet-18 on the 2D contour image placed >98.7% of identical-tone pairs in the best score band; MSE vs human raters 2.295 (subjective) / 0.189 (objective categorical).

MVP takeaway for tones: you do NOT need the ResNet. F0 extraction + LOESS smoothing + T-value normalization + nearest-canonical-contour (or a tiny logistic/DTW classifier on the 4 templates) is a buildable, fully local tone-correctness signal in JS/WASM or Rust. The expensive deep model is an accuracy refinement, not a prerequisite.

### 1.4 English phoneme and stress scoring

This is the mature, well-served case. GOP-style phoneme scoring (Azure, Speechace, SpeechSuper all do it) gives per-phoneme accuracy, and prosody scoring covers lexical stress, intonation, rhythm. English benefits from large acoustic models and IPA lexicons. If you ever want real numeric phoneme/stress feedback for English, buy it from Azure rather than build it; Azure returns per-phoneme IPA scores, syllable groups, and an NBestPhonemes list (what it thinks you actually said vs. the target), which is excellent learner feedback.

---

## 2. Commercial / API options

### 2.1 Azure AI Speech: Pronunciation Assessment

What it returns (verified against Microsoft Learn docs, updated 2025-11):
- Scores: AccuracyScore, FluencyScore, CompletenessScore, ProsodyScore, and an overall PronScore (weighted combination). 0 to 100 or 0 to 5 grading.
- Granularity: full-text, word, syllable, and phoneme levels. Phoneme alphabet IPA or SAPI.
- Per-phoneme `NBestPhonemes`: for each expected phoneme it returns the top-N phonemes it actually heard with confidence scores (great for "you said 'uh' instead of 'eh'" feedback).
- ErrorType per word: None, Omission, Insertion, Mispronunciation, UnexpectedBreak, MissingBreak, Monotone. (Mispronunciation fires when a word's accuracy < 60.)
- Scripted (you supply reference text, reading scenario) and unscripted (speaking scenario) modes.
- Streaming, unlimited duration; >30s requires continuous mode.
- Content assessment (vocabulary/grammar/topic) was retired from the SDK; Microsoft now tells you to call a chat model (gpt-4o) yourself for that.

Mandarin support, precisely:
- zh-CN is supported for the base accuracy/phoneme scoring, but only with the SAPI phoneme alphabet (you get phoneme NAME + score for zh-CN; IPA phoneme name, syllable groups, and "spoken phoneme" NBest are en-US ONLY).
- Prosody assessment is en-US ONLY.
- There is NO explicit Mandarin tone score in the API. You get phoneme-level accuracy for Mandarin but not a "tone 2 vs tone 3" verdict. For a Mandarin tone-teaching app, this is the dealbreaker that pushes you to SpeechSuper or DIY.

Pricing: pronunciation assessment is billed as standard speech-to-text (it is an add-on flag on STT). Effective cost is about $1/audio-hour base STT, roughly $1.32/hour effective with the real-time pronunciation add-on per community/Microsoft Q&A figures. Prorated per second, so a 5s word costs a fraction of a cent (~$0.002). Free tier exists (F0: limited hours/month).

### 2.2 Speechace

- Output: word/sentence/phoneme/syllable scores, fluency, lexical stress, intonation, IELTS/CEFR/PTE/TOEIC rubric scores (higher tiers). Patented syllable/phoneme-level scoring.
- Languages: English (US/UK), French (FR/CA), Spanish (ES/MX). Mandarin Chinese is NOT supported. Disqualified for the Mandarin half of this app.
- Pricing (from api-plans page): Basic $40/mo (5,000 15-sec requests, $0.008/extra), Pro $80/mo (10,000 reqs), Premium $125/mo ($0.0125/extra). Free trial.

### 2.3 SpeechSuper

- Output: overall, phoneme, word, sentence scores; phonics (English); and crucially a "Tone score (Chinese)" for word, short-text, and long-text Mandarin assessment.
- Languages: English, Mandarin Chinese (with tone), German, French, Spanish, Korean, Japanese, Russian.
- Pricing (Pay As You Go): word $0.004/request, sentence $0.006/request, paragraph $0.008/request; $20/mo minimum, prepay tiers from $500. Free trial.
- This is the ONLY surveyed turnkey API that explicitly grades Mandarin tones. If you want a credible numeric tone score without building one, this is the path.

### 2.4 ELSA Speak API

- Consumer-famous for English pronunciation; offers an API for per-sound, sentence (intonation/fluency), and speech-level (vocab/grammar) feedback. English-centric. No clear public Mandarin tone scoring. Pricing is "contact us" / partner-gated, not self-serve. Treat as English-only enterprise option.

### 2.5 Google Cloud Speech-to-Text

- Transcription + per-word confidence only. No pronunciation-assessment product, no phoneme scores, no tone scoring. Useful only as a transcription engine for a round-trip floor, and Whisper does that locally for free. Not recommended as the grading layer.

### Comparison table: commercial APIs

| Service | English phoneme score | Mandarin support | Mandarin TONE score | Prosody/stress | Rough price | Local? |
| --- | --- | --- | --- | --- | --- | --- |
| Azure Pronunciation Assessment | Yes (IPA + NBest) | Yes (accuracy, SAPI phoneme name) | No | en-US only | ~$1 to 1.32/audio-hr (~$0.002/word) | No (cloud; on-prem container exists for STT) |
| SpeechSuper | Yes | Yes | Yes (explicit Tone score) | Yes | $0.004 to 0.008/request | No |
| Speechace | Yes (patented) | No | No | Yes | $40 to 125/mo, ~$0.008/req | No |
| ELSA API | Yes | Unclear/No | No | Yes | Contact sales | No |
| Google Cloud STT | No (transcription only) | Transcription only | No | No | ~$0.016/15s (transcription) | No |

---

## 3. Local / on-device options

### 3.1 STT (for round-trip grading)

| Engine | Runtime fit | Mandarin | Short-utterance | Confidence / phoneme signal | Notes |
| --- | --- | --- | --- | --- | --- |
| whisper.cpp | Tauri (native, Rust/C bindings); also WASM | Yes (~8% WER medium/large on FLEURS zh) | Good with tiny/base; pad short clips, use initial_prompt | avg_logprob per segment; word timestamps via DTW | Best Tauri choice. Ships as a binary, GGUF models, GPU optional. |
| faster-whisper | Tauri via sidecar (Python/CTranslate2) | Yes | Good | word-level logprob/confidence | ~4x faster than openai/whisper, less memory. Needs Python runtime, heavier to bundle than whisper.cpp. |
| transformers.js (Whisper) | Web (WASM + WebGPU) | Yes (100 langs) | tiny (40MB) / small (240MB) run in browser | avg_logprob; word timestamps | Best WEB choice. WASM ~2 to 5x realtime on tiny; WebGPU (Chrome 113+) 3 to 5x faster. Models cached after first load, then offline. |
| Vosk | Tauri (native) or Node | Yes (monolingual zh model, ~50MB to bigger server models) | OK | Per-word confidence; phoneme posterior heatmap available | Gives a real per-phoneme probability surface (closest local thing to GOP signal), but Mandarin model is weaker than Whisper and English-word handling in zh model is poor. |
| Browser Web Speech API | Web only | zh-CN supported (Chrome) | OK | confidence on results; NO phoneme data | Chrome streams audio to Google servers (not local, not private, needs network). Safari 14.1+/14.5+ prefixed; Firefox behind flag. Not local-first. Avoid as the grading path; fine as a zero-dependency demo fallback. |

Key local STT findings:
- whisper.cpp (Tauri) and transformers.js Whisper (web) are the two pillars. Same model family, fully local, free, private. Whisper zh transcription is solid (~8% WER) for whole syllables/words; it will NOT reliably surface tone errors (LM corrects them).
- For short single-word clips, Whisper can hallucinate or drop; mitigate with VAD trimming, a small silence pad, and an `initial_prompt` hinting the expected vocabulary. The round-trip check should normalize (strip punctuation, compare hanzi or pinyin-without-tone, allow homophone sets).
- Vosk is the only easy local engine that exposes a phoneme-posterior signal you could turn into a crude GOP, but its Mandarin quality lags Whisper. Treat as experimental, not the default.

### 3.2 TTS (speak-aloud)

| Engine | Runtime fit | Mandarin quality | License | Size / cost | Notes |
| --- | --- | --- | --- | --- | --- |
| Kokoro (82M) | Web (kokoro-js, ONNX/WASM, WebGPU) AND Tauri (ONNX/sherpa) | Yes, native Mandarin voices (good prosody/tone) | Apache-2.0 (commercial OK) | 82M params, <2GB VRAM, runs on CPU | Best all-around local pick: one model, web + desktop, permissive license, real Mandarin. kokoro-js runs in browser. |
| Piper | Tauri (sherpa-onnx, sherpa-rs Rust bindings); web via WASM/sherpa | Yes (VITS multi-speaker, 8 langs incl. Mandarin) | Original MIT; repo archived 2025, community fork now GPL-3.0 (check the fork you use) | ~tens of MB per voice, runs on Raspberry Pi | Excellent for Tauri (Rust binding via sherpa-rs). Watch the GPL-3.0 license on the maintained fork. Mandarin voices exist but quality/tone varies by voice. |
| Coqui XTTS v2 | Tauri (heavy, GPU-ish) | Yes (zh-cn), high quality + voice cloning | Coqui Public Model License (RESTRICTS commercial use) | Large | License restriction makes it a poor fit for a shipped product. Skip unless you clear the license. |
| Browser SpeechSynthesis | Web only | zh-CN if OS/voice installed (quality varies wildly by OS) | Free (OS voices) | Zero bundle | Zero-dependency fallback. Quality and tone correctness are inconsistent across Windows/macOS/Linux. Fine as a stopgap, not a primary teaching voice. |

Key TTS finding: Kokoro is the standout for this app. One 82M Apache-2.0 model covers both English and Mandarin, runs in the browser (kokoro-js, ONNX/WASM/WebGPU) AND on Tauri (ONNX via sherpa-onnx), and has genuine Mandarin voices with proper tone realization. Piper is the strong Tauri alternative (clean Rust binding via sherpa-rs) but mind the GPL-3.0 on the current maintained fork. Avoid XTTS (license) and treat browser SpeechSynthesis as a no-bundle fallback only.

### 3.3 Pitch / F0 extraction (for DIY Mandarin tone scoring)

You need F0 contours per syllable, in JS/WASM (web) or Rust (Tauri). Options:

| Method | Where it runs | Notes |
| --- | --- | --- |
| Autocorrelation / YIN / pYIN | JS or Rust, real-time | pYIN (probabilistic YIN) is the librosa-grade monophonic F0 estimator. There are JS and Rust/WASM autocorrelation pitch trackers (guitar-tuner-grade, 60fps in browser). Cheapest, fully local, good enough for clean single-syllable voice. Start here. |
| CREPE (CNN pitch model) | ONNX in WASM/WebGPU (web) or ONNX in Rust (Tauri) | More accurate than pYIN/SWIPE per the 2018 paper, especially on noisy/breathy voice. A model to ship (a few MB) but gives cleaner contours. Upgrade path if pYIN is too noisy on real users. |
| WORLD vocoder / Praat-style | Rust/C port or WASM | What the Nature paper used. Highest-fidelity F0 but heavier. Overkill for MVP. |

DIY tone-scoring pipeline (all local, no cloud): VAD-trim the syllable, extract F0 (pYIN to start), drop unvoiced frames, LOESS-smooth, normalize to the 5-level T-value scale (speaker-independent), then compare the normalized contour to the 4 canonical tone templates (nearest-template or DTW distance) for a tone-correctness verdict and a confidence. This is a few hundred lines, runs in WASM or Rust, and gives the ONE signal that neither Whisper round-trip nor Azure gives you locally.

---

## 4. Feasibility verdict

### Realistic MVP grading signal (ship now)
- English and Mandarin word/phrase, "recognized correctly" floor: local Whisper round-trip. Transcribe, normalize, compare to target. Report binary pass + optionally Whisper confidence as a soft "clarity" hint (clearly labeled, not a pronunciation grade). Honest, free, offline, private.
- Mandarin tone, real signal: local F0 + contour-template tone classifier (pYIN -> LOESS -> T-value normalize -> nearest canonical tone). Gives "you said tone 3, target was tone 2" feedback that the round-trip fundamentally cannot. This is the differentiator and it is buildable.

### Overkill / defer (research projects)
- Building GOP/Kaldi/MFA forced-alignment scoring in-house: heavy native deps, alignment-error fragility, months of acoustic-model and lexicon work. Buy it (Azure) if you need it.
- Training your own ResNet/Siamese tone model: the template/DTW approach already gives a usable tone verdict; the deep model is an accuracy refinement to revisit only if real-user data shows the template approach is too lenient.
- Calibrated 0 to 100 pronunciation scores from Whisper logprob: the data says logprob tracks transcription accuracy (R=-0.94), not human pronunciation grades (R=-0.57). Do not pretend otherwise. Use a real API when you need a real number.

### When to reach for cloud
- You want a credible numeric English pronunciation score with per-phoneme "you said X not Y" feedback: Azure Pronunciation Assessment (~$0.002/word, IPA + NBestPhonemes).
- You want a turnkey numeric Mandarin tone score without building the F0 classifier: SpeechSuper (~$0.004 to 0.008/request, explicit Tone score). Cloud is acceptable here per the brief; gate it behind an opt-in toggle to preserve local-first defaults.

---

## 5. Recommended MVP stack

Principle: local-first, free, and private by default; cloud as an explicit opt-in "deep feedback" upgrade. Same conceptual stack on both runtimes, different concrete bindings.

### Shared (both web and Tauri)
- TTS speak-aloud: Kokoro (82M, Apache-2.0). One model, English + Mandarin, real tone. kokoro-js on web, ONNX/sherpa on Tauri.
- STT capture for round-trip: Whisper (tiny or base; consider small for zh accuracy if perf allows).
- Tone score (Mandarin): DIY local F0 pipeline (pYIN -> LOESS smooth -> T-value normalize -> nearest canonical-tone-template / DTW). CREPE-ONNX as an accuracy upgrade.
- Round-trip grader: normalize transcription (strip punctuation; for zh compare hanzi and/or toneless pinyin, allow homophone sets) and compare to target. Binary pass + soft confidence hint.
- Optional cloud "deep feedback" toggle: Azure (English phoneme breakdown) and/or SpeechSuper (Mandarin tone number). Off by default.

### Web app
- TTS: kokoro-js (ONNX via WASM, WebGPU when available).
- STT: transformers.js Whisper (WASM baseline, WebGPU on Chrome 113+; tiny=40MB, small=240MB; cache after first load for offline use).
- F0/tone: pYIN or autocorrelation in JS, or CREPE via ONNX Runtime Web (WASM/WebGPU). Web Audio API to capture mic and frame the signal.
- Fallbacks: browser SpeechSynthesis (TTS) and Web Speech API (STT) as zero-bundle degraded modes only; both are inconsistent and Web Speech STT is non-local (Chrome sends audio to Google), so never the default grading path.

### Tauri desktop
- TTS: Piper via sherpa-rs (Rust binding to sherpa-onnx) OR Kokoro via ONNX. Prefer Kokoro for license cleanliness (Apache-2.0) and single-model English+Mandarin; use Piper if you want the lightest per-voice footprint (mind the fork's GPL-3.0).
- STT: whisper.cpp (native, GGUF models, optional GPU). Best local accuracy/perf and trivial to bundle as a sidecar binary.
- F0/tone: pYIN/CREPE in Rust (ONNX Runtime via `ort`), or reuse the WASM module from the web build. Capture mic via Tauri/cpal.
- Reuse the exact same round-trip and tone-template logic as web (share it as a WASM or Rust crate) so grading is identical across runtimes.

### One-line summary of the recommendation
Ship Kokoro (TTS) + local Whisper round-trip (STT match) + a DIY F0 tone-template classifier (Mandarin tones), all local and free; keep Azure (English phonemes) and SpeechSuper (Mandarin tone number) as an opt-in cloud upgrade for users who want a graded numeric score.

---

## Sources

- Azure Pronunciation Assessment, Microsoft Learn (how-to, result params, zh-CN/SAPI limits, scoring formulas): https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-pronunciation-assessment
- Azure Speech pricing: https://azure.microsoft.com/en-us/pricing/details/speech/ and Microsoft Q&A on pronunciation-assessment pricing: https://learn.microsoft.com/en-us/answers/questions/5608069/
- Speechace API plans (pricing, languages: no Mandarin): https://www.speechace.com/api-plans/
- SpeechSuper pricing and Mandarin Tone score: https://www.speechsuper.com/pricing.html
- ELSA API: https://elsaspeak.com/en/elsa-api/
- GOP / forced-alignment reliability: "The Impact of Forced-Alignment Errors on Automatic Pronunciation Evaluation" (Interspeech 2021) https://www.isca-archive.org/interspeech_2021/mathad21_interspeech.pdf ; Context-aware GOP https://arxiv.org/abs/2008.08647
- Whisper-scoring reliability for L2 (R=-0.94 vs Levenshtein, R=-0.57 vs human grades): Ballier and Meli, NLP4CALL 2024 https://aclanthology.org/2024.nlp4call-1.2.pdf
- Mandarin tone scoring (ResNet Siamese, F0 + WORLD + LOESS + T-value): Scientific Reports 2025 https://www.nature.com/articles/s41598-025-08544-8 ; CNN tone classification https://github.com/alicex2020/Mandarin-Tone-Classification
- CREPE pitch estimation: https://github.com/marl/crepe and paper https://www.justinsalamon.com/uploads/4/3/9/4/4394963/kim_crepe_icassp_2018.pdf ; Rust/WASM real-time pitch detection: https://github.com/alesgenova/pitch-detection-app
- whisper.cpp / faster-whisper / transformers.js browser Whisper (WASM/WebGPU perf): https://github.com/huggingface/transformers.js/ ; https://www.assemblyai.com/blog/offline-speech-recognition-whisper-browser-node-js
- Vosk (offline, per-word confidence, phoneme heatmap, Mandarin model): https://alphacephei.com/vosk/ and https://github.com/alphacep/vosk-api
- Web Speech API support/limits (Chrome cloud, Safari prefixed, Firefox flag): https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API
- Kokoro TTS (82M, Apache-2.0, Mandarin, kokoro-js): https://github.com/hexgrad/kokoro
- Piper TTS (MIT -> GPL-3.0 fork, Mandarin VITS, sherpa-rs Rust binding): https://github.com/OHF-Voice/piper1-gpl and https://github.com/Limit-LAB/sherpa-rs
- Coqui XTTS v2 (zh-cn, Coqui Public Model License restricts commercial): https://github.com/coqui-ai/TTS
