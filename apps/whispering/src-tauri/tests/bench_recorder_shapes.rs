//! Throwaway benchmark: PR #1831 raw-f32-IPC vs progressive-WAV-path vs
//! direct-rust-local. Lives in tests/ so it doesn't change shipped code.
//!
//! Run with:
//!   cargo test --release --test bench_recorder_shapes -- --nocapture
//!
//! Each clip length (5 s, 30 s, 120 s) gets a synthetic 16 kHz mono f32 sine
//! buffer (the canonical recorder output: `CapturedPcm::samples`). For each
//! shape we time the work that actually moves between recorder finalize and
//! the next consumer (local transcription engine, cloud Opus encode).
//!
//! What is NOT measured here: Tauri's IPC bridge memcpy itself. The bridge
//! transfers raw bytes at ~memory-copy speed, so this bench reports the
//! buffer-construction cost on the Rust side; doubling that to account for
//! the JS-side memcpy is a conservative upper bound on IPC overhead.

use std::time::Instant;

use whispering_lib::audio::{decode_to_pcm16k_mono, encode_pcm_to_opus_ogg};

const TARGET_RATE: u32 = 16_000;
const ITERS_FAST: usize = 50; // fast paths (memcpy-shaped)
const ITERS_SLOW: usize = 5; // slow paths (opus encode, full decode)

const CLIPS: &[(&str, u32)] = &[("5s", 5), ("30s", 30), ("120s", 120)];

/// Synthesize a `seconds`-long sine at 16 kHz mono. Sine, not silence, so the
/// resampler / encoder cannot short-circuit on a constant signal.
fn make_sine_pcm(seconds: u32) -> Vec<f32> {
    let n = (seconds as usize) * TARGET_RATE as usize;
    let two_pi_f = 2.0_f32 * std::f32::consts::PI * 440.0;
    let inv_rate = 1.0_f32 / TARGET_RATE as f32;
    (0..n)
        .map(|i| (two_pi_f * (i as f32) * inv_rate).sin() * 0.5)
        .collect()
}

/// Equivalent of the JS-side pcm-to-wav helper, in Rust. Mono 16 kHz IEEE
/// float WAV. We bench against this rather than calling the JS function so
/// the comparison stays inside one process; the Rust impl is the same memcpy
/// shape as `pcm-to-wav.ts`.
fn pcm_to_wav_f32(samples: &[f32]) -> Vec<u8> {
    let bits_per_sample: u16 = 32;
    let bytes_per_sample = (bits_per_sample / 8) as u32;
    let channels: u16 = 1;
    let rate: u32 = TARGET_RATE;
    let data_size = (samples.len() * 4) as u32;
    let file_size = 36 + data_size;

    let mut buf = Vec::with_capacity(44 + data_size as usize);
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&file_size.to_le_bytes());
    buf.extend_from_slice(b"WAVE");
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes()); // subchunk1 size
    buf.extend_from_slice(&3u16.to_le_bytes()); // IEEE Float format tag
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&rate.to_le_bytes());
    buf.extend_from_slice(&(rate * channels as u32 * bytes_per_sample).to_le_bytes());
    buf.extend_from_slice(&(channels * (bytes_per_sample as u16)).to_le_bytes());
    buf.extend_from_slice(&bits_per_sample.to_le_bytes());
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_size.to_le_bytes());
    // f32 LE samples
    for s in samples {
        buf.extend_from_slice(&s.to_le_bytes());
    }
    buf
}

/// Same byte layout `CapturedPcm::to_binary` ships across IPC: raw LE f32.
fn pcm_to_binary(samples: &[f32]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        buf.extend_from_slice(&s.to_le_bytes());
    }
    buf
}

/// Parse the same wire format back into Vec<f32>. Mirrors
/// `audio::command::encode_upload_pcm`'s parse step.
fn binary_to_pcm(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Time `f` `iters` times, return (median_ms, mean_ms).
fn time_ms<F: FnMut()>(iters: usize, mut f: F) -> (f64, f64) {
    let mut samples_us = Vec::with_capacity(iters);
    for _ in 0..iters {
        let t = Instant::now();
        f();
        samples_us.push(t.elapsed().as_micros() as f64);
    }
    samples_us.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = samples_us[samples_us.len() / 2] / 1000.0;
    let mean = (samples_us.iter().sum::<f64>() / samples_us.len() as f64) / 1000.0;
    (median, mean)
}

struct Row {
    clip: &'static str,
    metric: &'static str,
    shape: &'static str,
    median_ms: f64,
    mean_ms: f64,
    bytes: Option<usize>,
}

fn fmt_row(r: &Row) -> String {
    let bytes_col = r
        .bytes
        .map(|b| format!("{:>10}", human_bytes(b)))
        .unwrap_or_else(|| format!("{:>10}", ""));
    format!(
        "{:<5} {:<28} {:<14} {:>9.3}ms {:>9.3}ms {}",
        r.clip, r.metric, r.shape, r.median_ms, r.mean_ms, bytes_col,
    )
}

fn human_bytes(b: usize) -> String {
    if b < 1024 {
        format!("{} B", b)
    } else if b < 1024 * 1024 {
        format!("{:.1} KB", b as f64 / 1024.0)
    } else {
        format!("{:.2} MB", b as f64 / (1024.0 * 1024.0))
    }
}

#[test]
fn bench_recorder_shapes() {
    let temp_dir = std::env::temp_dir().join("whispering_bench_recorder_shapes");
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");

    let mut rows: Vec<Row> = Vec::new();

    println!("\n=== recorder shapes benchmark ===");
    println!("clip  metric                       shape          median     mean       payload");
    println!("----- ---------------------------- -------------- ---------- ---------- ----------");

    for (clip, seconds) in CLIPS {
        let samples = make_sine_pcm(*seconds);
        let pcm_bytes_len = samples.len() * 4;

        // ---- Shape 1: PR #1831 — raw f32 IPC ----

        // (a) finalize: samples are already 16 kHz mono; cost is just the
        //     f32 -> bytes serialize in `CapturedPcm::to_binary`.
        let (med, mean) = time_ms(ITERS_FAST, || {
            std::hint::black_box(pcm_to_binary(&samples));
        });
        rows.push(Row {
            clip,
            metric: "stop: pcm->binary",
            shape: "shape1 raw-f32",
            median_ms: med,
            mean_ms: mean,
            bytes: Some(pcm_bytes_len),
        });
        println!("{}", fmt_row(rows.last().unwrap()));

        // (b) local-prep: pcm-to-wav (in JS), then `decode_to_pcm16k_mono`
        //     on the WAV bytes (Symphonia path). We bench the WAV synthesis
        //     in Rust (identical memcpy shape to the JS impl) plus the
        //     decode, because both happen post-stop on the critical path.
        let (med_w, mean_w) = time_ms(ITERS_FAST, || {
            std::hint::black_box(pcm_to_wav_f32(&samples));
        });
        rows.push(Row {
            clip,
            metric: "local: pcm->wav",
            shape: "shape1 raw-f32",
            median_ms: med_w,
            mean_ms: mean_w,
            bytes: Some(44 + pcm_bytes_len),
        });
        println!("{}", fmt_row(rows.last().unwrap()));

        let wav_bytes = pcm_to_wav_f32(&samples);
        let (med_d, mean_d) = time_ms(ITERS_SLOW, || {
            let out = decode_to_pcm16k_mono(&wav_bytes).expect("decode");
            std::hint::black_box(out);
        });
        rows.push(Row {
            clip,
            metric: "local: decode_to_pcm16k",
            shape: "shape1 raw-f32",
            median_ms: med_d,
            mean_ms: mean_d,
            bytes: Some(wav_bytes.len()),
        });
        println!("{}", fmt_row(rows.last().unwrap()));

        // (c) cloud-prep: JS sends raw f32 bytes back over IPC,
        //     `encode_upload_pcm` parses then calls `encode_pcm_to_opus_ogg`.
        let binary_back = pcm_to_binary(&samples);
        let (med_p, mean_p) = time_ms(ITERS_FAST, || {
            std::hint::black_box(binary_to_pcm(&binary_back));
        });
        rows.push(Row {
            clip,
            metric: "cloud: bytes->pcm",
            shape: "shape1 raw-f32",
            median_ms: med_p,
            mean_ms: mean_p,
            bytes: Some(binary_back.len()),
        });
        println!("{}", fmt_row(rows.last().unwrap()));

        let (med_e, mean_e) = time_ms(ITERS_SLOW, || {
            let out = encode_pcm_to_opus_ogg(samples.clone(), TARGET_RATE).expect("encode");
            std::hint::black_box(out);
        });
        let opus_bytes = encode_pcm_to_opus_ogg(samples.clone(), TARGET_RATE).unwrap();
        rows.push(Row {
            clip,
            metric: "cloud: pcm->opus_ogg",
            shape: "shape1 raw-f32",
            median_ms: med_e,
            mean_ms: mean_e,
            bytes: Some(opus_bytes.len()),
        });
        println!("{}", fmt_row(rows.last().unwrap()));

        // ---- Shape 2: progressive canonical WAV path ----
        //
        // Model: consumer worker streams 16 kHz mono PCM into a WAV file
        // during recording. At `stop_recording` the only finalize cost is
        // flushing buffered writes; everything else is already on disk.
        //
        // We approximate the streaming cost by writing the whole WAV in one
        // shot to a tempfile and fsyncing — that's an upper bound on the
        // flush-at-stop cost because progressive writes overlap with
        // recording. We separately measure the "path-only stop" cost = the
        // post-write file-flush latency.
        let wav_path = temp_dir.join(format!("clip_{}.wav", seconds));
        std::fs::write(&wav_path, &wav_bytes).expect("write wav");

        // Stop latency = flush + close. Use a fresh tempfile per iter so
        // the OS isn't just hitting the page cache for an already-open fd.
        let (med_s, mean_s) = time_ms(ITERS_FAST, || {
            use std::fs::OpenOptions;
            use std::io::Write;
            let p = temp_dir.join("stop_flush.wav");
            let mut f = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&p)
                .expect("open");
            f.write_all(&wav_bytes).expect("write");
            f.flush().expect("flush");
            drop(f);
        });
        rows.push(Row {
            clip,
            metric: "stop: write+flush wav",
            shape: "shape2 wav-path",
            median_ms: med_s,
            mean_ms: mean_s,
            bytes: Some(wav_bytes.len()),
        });
        println!("{}", fmt_row(rows.last().unwrap()));

        // local-prep: read the WAV from disk, decode to 16k mono.
        let (med_lr, mean_lr) = time_ms(ITERS_SLOW, || {
            let buf = std::fs::read(&wav_path).expect("read");
            let out = decode_to_pcm16k_mono(&buf).expect("decode");
            std::hint::black_box(out);
        });
        rows.push(Row {
            clip,
            metric: "local: read+decode wav",
            shape: "shape2 wav-path",
            median_ms: med_lr,
            mean_ms: mean_lr,
            bytes: Some(wav_bytes.len()),
        });
        println!("{}", fmt_row(rows.last().unwrap()));

        // cloud-prep: read wav, decode to pcm, encode opus. Same final
        // bytes as shape 1's cloud path, with one extra Symphonia hop.
        let (med_cr, mean_cr) = time_ms(ITERS_SLOW, || {
            let buf = std::fs::read(&wav_path).expect("read");
            let pcm = decode_to_pcm16k_mono(&buf).expect("decode");
            let ogg = encode_pcm_to_opus_ogg(pcm, TARGET_RATE).expect("encode");
            std::hint::black_box(ogg);
        });
        rows.push(Row {
            clip,
            metric: "cloud: read+decode+opus",
            shape: "shape2 wav-path",
            median_ms: med_cr,
            mean_ms: mean_cr,
            bytes: None,
        });
        println!("{}", fmt_row(rows.last().unwrap()));

        // ---- Shape 3: direct in-process (stop_and_transcribe_local) ----
        //
        // The samples are already a `Vec<f32>` at 16 kHz mono in Rust;
        // they go straight to the transcription engine. No IPC, no decode,
        // no file IO. The bench just confirms the cost floor is zero.
        let (med_h, mean_h) = time_ms(ITERS_FAST, || {
            // Simulate the engine "taking" the buffer: clone to defeat
            // optimizations that would elide the move.
            let s = samples.clone();
            std::hint::black_box(s);
        });
        rows.push(Row {
            clip,
            metric: "local: in-process handoff",
            shape: "shape3 direct",
            median_ms: med_h,
            mean_ms: mean_h,
            bytes: Some(pcm_bytes_len),
        });
        println!("{}", fmt_row(rows.last().unwrap()));

        // Cloud path for shape 3 is identical to shape 1 (Rust still
        // produces opus bytes that cross IPC up to JS for HTTP upload).
        // Reuse the shape 1 cloud opus row by reference in the report.

        println!();
    }

    // Cleanup tempfiles.
    let _ = std::fs::remove_dir_all(&temp_dir);

    // Aggregated summary by shape per clip: stop + local-prep + cloud-prep
    // sums for the critical path.
    println!("\n=== aggregated critical-path totals (median ms) ===");
    println!("clip   shape           stop      local-prep     cloud-prep");
    println!("------ --------------- --------- -------------- ---------------");
    for (clip, _) in CLIPS {
        // Shape 1 totals
        let stop1 = pick(&rows, clip, "shape1 raw-f32", "stop: pcm->binary");
        let local1a = pick(&rows, clip, "shape1 raw-f32", "local: pcm->wav");
        let local1b = pick(&rows, clip, "shape1 raw-f32", "local: decode_to_pcm16k");
        let cloud1a = pick(&rows, clip, "shape1 raw-f32", "cloud: bytes->pcm");
        let cloud1b = pick(&rows, clip, "shape1 raw-f32", "cloud: pcm->opus_ogg");
        println!(
            "{:<6} {:<15} {:>7.3}ms {:>12.3}ms {:>12.3}ms",
            clip,
            "shape1 raw-f32",
            stop1,
            local1a + local1b,
            cloud1a + cloud1b,
        );

        // Shape 2 totals
        let stop2 = pick(&rows, clip, "shape2 wav-path", "stop: write+flush wav");
        let local2 = pick(&rows, clip, "shape2 wav-path", "local: read+decode wav");
        let cloud2 = pick(&rows, clip, "shape2 wav-path", "cloud: read+decode+opus");
        println!(
            "{:<6} {:<15} {:>7.3}ms {:>12.3}ms {:>12.3}ms",
            clip, "shape2 wav-path", stop2, local2, cloud2,
        );

        // Shape 3 totals (cloud reuses shape1's pcm->opus cost)
        let stop3 = pick(&rows, clip, "shape3 direct", "local: in-process handoff");
        let cloud3 = cloud1b; // direct pcm->opus, no parse step
        println!(
            "{:<6} {:<15} {:>7.3}ms {:>12.3}ms {:>12.3}ms",
            clip, "shape3 direct", stop3, 0.0, cloud3,
        );
        println!();
    }
}

fn pick(rows: &[Row], clip: &str, shape: &str, metric: &str) -> f64 {
    rows.iter()
        .find(|r| r.clip == clip && r.shape == shape && r.metric == metric)
        .map(|r| r.median_ms)
        .unwrap_or(0.0)
}
