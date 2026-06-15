//! Cancelable HTTP file downloads.
//!
//! Replaces `tauri-plugin-upload`'s `download` for model files. That plugin
//! streams `reqwest` -> `tokio::fs` inside a detached `tokio::spawn` and keeps
//! no handle to the task, so a started download cannot be stopped: dropping the
//! JS promise leaves the bytes moving in Rust.
//!
//! Here the streaming task's `AbortHandle` is registered in a `DownloadManager`
//! keyed by a frontend-owned download id, so `cancel_download(id)` can abort the
//! in-flight transfer. An aborted transfer surfaces as an `Err` on the matching
//! `download_file` call.
//!
//! This module is deliberately cancel- and layout-agnostic: it streams bytes
//! into the path it is given and reports raw byte counts. The frontend owns the
//! `.partial` convention and the size check that promotes it
//! (`local-model-folder.ts`), and removes the partial on any error (including a
//! cancel), so there is nothing for Rust to clean up.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::AsyncWriteExt;

/// In-flight download registry. Holds one `AbortHandle` per download id while
/// its transfer task runs; `cancel_download` aborts the task through it. The
/// frontend mints a fresh, unique `download_id` for every download attempt, so
/// an id maps to exactly one transfer for its whole lifetime: `register` can
/// never overwrite a live entry, and `unregister`/`abort` can never touch a
/// different attempt's entry. A plain map is enough.
#[derive(Default)]
pub struct DownloadManager {
    inflight: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

impl DownloadManager {
    fn register(&self, id: &str, handle: tokio::task::AbortHandle) {
        self.inflight
            .lock()
            .expect("download registry poisoned")
            .insert(id.to_string(), handle);
    }

    /// Drop the entry after the transfer settles. Download ids are unique per
    /// attempt, so this only ever removes its own entry.
    fn unregister(&self, id: &str) {
        self.inflight
            .lock()
            .expect("download registry poisoned")
            .remove(id);
    }

    fn abort(&self, id: &str) {
        if let Some(handle) = self
            .inflight
            .lock()
            .expect("download registry poisoned")
            .remove(id)
        {
            handle.abort();
        }
    }
}

/// Whole-file download progress: bytes received so far and the total to expect.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    /// Bytes received so far. `f64` because specta forbids exporting 64-bit
    /// ints to TypeScript; model sizes are far below `f64`'s 2^53 exact-integer
    /// ceiling, so no precision is lost.
    bytes_received: f64,
    /// Total bytes from the response `content-length`, or 0 when the server
    /// omits it. The frontend falls back to the catalog size in that case.
    total_bytes: f64,
}

/// Stream a URL to a file on disk, reporting whole-file progress on `channel`.
/// Pure transfer; registration and cancellation live in `download_file`.
async fn stream_to_file(
    url: &str,
    file_path: &str,
    channel: Channel<DownloadProgress>,
) -> Result<(), String> {
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "request failed with status code {}",
            response.status().as_u16()
        ));
    }
    let total_bytes = response.content_length().unwrap_or(0) as f64;

    let mut file = tokio::io::BufWriter::new(
        tokio::fs::File::create(file_path)
            .await
            .map_err(|e| e.to_string())?,
    );

    let mut bytes_received: u64 = 0;
    let mut last_emit = Instant::now();
    // A download fires thousands of small chunks, but each `send` crosses IPC
    // and repaints the progress bar, and no one reads progress faster than this.
    // Throttle to ~10/sec; the true final count is force-sent after the loop.
    let throttle = Duration::from_millis(100);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        bytes_received += chunk.len() as u64;
        if last_emit.elapsed() >= throttle {
            // The receiver may already be gone (e.g. window closed); ignore.
            let _ = channel.send(DownloadProgress {
                bytes_received: bytes_received as f64,
                total_bytes,
            });
            last_emit = Instant::now();
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    // Land on the true final byte count (typically 100%); the throttle may have
    // skipped the last chunk's update.
    let _ = channel.send(DownloadProgress {
        bytes_received: bytes_received as f64,
        total_bytes,
    });
    Ok(())
}

/// Download `url` to `file_path`, cancelable via `cancel_download(download_id)`.
///
/// Runs the transfer in a `tokio` task whose `AbortHandle` is registered under
/// `download_id`. A cancel aborts the task at its next await point, which
/// surfaces here as an `Err`; the frontend, which knows it requested the
/// cancel, treats that error as a clean stop.
#[tauri::command]
#[specta::specta]
pub async fn download_file(
    download_id: String,
    url: String,
    file_path: String,
    on_progress: Channel<DownloadProgress>,
    manager: State<'_, DownloadManager>,
) -> Result<(), String> {
    let task = tokio::spawn(async move { stream_to_file(&url, &file_path, on_progress).await });
    manager.register(&download_id, task.abort_handle());

    let outcome = task.await;
    manager.unregister(&download_id);

    match outcome {
        Ok(inner) => inner,
        Err(join_err) => Err(format!("download interrupted: {join_err}")),
    }
}

/// Abort the in-flight download registered under `download_id`, if any. The
/// matching `download_file` call then resolves with an `Err`. A no-op when
/// nothing is downloading under that id (already finished, or cancelled between
/// files), so it is always safe to call.
#[tauri::command]
#[specta::specta]
pub fn cancel_download(download_id: String, manager: State<'_, DownloadManager>) {
    manager.abort(&download_id);
}
