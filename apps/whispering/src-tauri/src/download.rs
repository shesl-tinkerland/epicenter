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
//! This module is deliberately layout-agnostic: it streams bytes into the path
//! it is given (`stream_to_file`) and runs a transfer as a cancelable task
//! (`DownloadManager::run`). The `.partial` staging convention, the per-file
//! size check, and the promote-rename live one layer up in
//! `transcription::model_folder::download_model`, which owns the folder.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
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

    /// Run `fut` as a cancelable task registered under `id`: `cancel_download(id)`
    /// aborts it, which drops the future (running any staging-cleanup `Drop`) and
    /// surfaces here as an `Err`. The caller, which knows it requested the cancel,
    /// treats that error as a clean stop. Always unregisters, so a finished or
    /// aborted id is safe to cancel again (a no-op).
    pub(crate) async fn run<T>(
        &self,
        id: &str,
        fut: impl Future<Output = T> + Send + 'static,
    ) -> Result<T, String>
    where
        T: Send + 'static,
    {
        let task = tokio::spawn(fut);
        self.register(id, task.abort_handle());
        let outcome = task.await;
        self.unregister(id);
        outcome.map_err(|join_err| format!("download interrupted: {join_err}"))
    }
}

/// Cumulative download progress for one model: bytes received so far across all
/// of its files, and the grand total to expect. The frontend turns it into a
/// 0-100 percent.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    /// Bytes received so far. `f64` because specta forbids exporting 64-bit
    /// ints to TypeScript; model sizes are far below `f64`'s 2^53 exact-integer
    /// ceiling, so no precision is lost.
    bytes_received: f64,
    /// Grand total bytes for the whole model (sum of the catalog file sizes).
    total_bytes: f64,
}

impl DownloadProgress {
    pub(crate) fn new(bytes_received: f64, total_bytes: f64) -> Self {
        Self {
            bytes_received,
            total_bytes,
        }
    }
}

/// Stream a URL to a file on disk, reporting this file's running byte count
/// through `on_progress` (throttled to ~10/sec). Returns the final byte count.
/// Pure transfer; the caller owns cumulative aggregation, registration, and
/// cancellation (`DownloadManager::run`).
pub(crate) async fn stream_to_file(
    url: &str,
    file_path: &str,
    mut on_progress: impl FnMut(u64),
) -> Result<u64, String> {
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

    let mut file = tokio::io::BufWriter::new(
        tokio::fs::File::create(file_path)
            .await
            .map_err(|e| e.to_string())?,
    );

    let mut bytes_received: u64 = 0;
    let mut last_emit = Instant::now();
    // A download fires thousands of small chunks, but each progress send crosses
    // IPC and repaints the bar, and no one reads progress faster than this.
    // Throttle to ~10/sec; the true final count is force-sent after the loop.
    let throttle = Duration::from_millis(100);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        bytes_received += chunk.len() as u64;
        if last_emit.elapsed() >= throttle {
            on_progress(bytes_received);
            last_emit = Instant::now();
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    // Land on the true final byte count; the throttle may have skipped the last
    // chunk's update.
    on_progress(bytes_received);
    Ok(bytes_received)
}

/// Abort the in-flight download registered under `download_id`, if any. The
/// matching `download_model` call then resolves with an `Err` (and its staging
/// is cleaned up by the dropped task). A no-op when nothing is downloading under
/// that id, so it is always safe to call.
#[tauri::command]
#[specta::specta]
pub fn cancel_download(download_id: String, manager: State<'_, DownloadManager>) {
    manager.abort(&download_id);
}
