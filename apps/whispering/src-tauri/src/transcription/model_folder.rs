//! The webview-facing read/write surface over the engine models folders.
//!
//! Rust owns filesystem truth for the models folder: enumeration, symlink
//! resolution, stat, delete, folder creation, and the full download
//! (stage -> validate -> promote). The webview owns the catalog
//! (`constants/local-models.ts`) and the size-validity threshold, and passes
//! catalog data in per call; nothing here stores it.
//!
//! Why this lives in Rust and not the webview `plugin-fs`: a "bring your own
//! model" entry is a symlink whose target lives outside the webview's
//! `fs:scope`, so JS cannot stat through it (a dead link would read as
//! installed) or unlink it (the user could never remove it from the UI). Rust
//! reads natively and follows links, so one code path serves linked, downloaded,
//! and hand-dropped entries alike. The byte transport and cancellation live one
//! layer down in `crate::download`; this module owns the folder layout
//! (`.partial` staging, the promote rename) on top of it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use thiserror::Error;

use crate::download::{stream_to_file, DownloadManager, DownloadProgress};

use super::config::Engine;
use super::model_cache::{engine_models_path, is_contained_entry_name};
use super::model_import::{unlink_symlink, WHISPER_EXTENSIONS};

#[derive(Error, Debug, Serialize, Deserialize, specta::Type)]
#[serde(tag = "name")]
pub enum ModelFolderError {
    /// The entry name (or a download filename) is not a single folder entry.
    #[error("{message}")]
    InvalidEntryName { message: String },

    /// Could not read the models folder or resolve its path.
    #[error("{message}")]
    ReadFailed { message: String },

    /// Removing the entry failed.
    #[error("{message}")]
    DeleteFailed { message: String },

    /// A download finished smaller than its catalog size (a dropped connection
    /// leaves a truncated file that still "loads" but transcribes garbage).
    #[error("{message}")]
    DownloadIncomplete { message: String },

    /// A download failed or was cancelled (an aborted transfer surfaces here).
    #[error("{message}")]
    DownloadFailed { message: String },

    /// Could not create or open the models folder.
    #[error("{message}")]
    RevealFailed { message: String },
}

/// One selectable entry in an engine's models folder.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    /// File or directory name inside the engine's models folder.
    pub name: String,
    /// Whether the entry is a symlink (a "bring your own model" link). Display
    /// only ("Your model (linked)"); it does not change how the entry loads.
    pub linked: bool,
}

/// One file to download for a model. Mirrors the catalog shape: a Whisper model
/// passes a single file, a directory engine passes one per contained file.
#[derive(Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelFileDownload {
    pub url: String,
    /// Filename inside the entry directory (directory engines). Ignored for the
    /// single-file Whisper case, where the entry itself is the file.
    pub filename: String,
    /// Catalog size in bytes; the integrity check and progress total use it.
    pub size_bytes: f64,
}

/// One file's presence and completeness in a model entry, resolved through any
/// symlink. The webview supplies expected catalog sizes and reads back both the
/// stat'd `size` (for messaging) and the `complete` verdict (for installed /
/// truncated decisions). The completeness rule itself lives in Rust; see
/// `is_size_complete`.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelFileStatus {
    /// File size in bytes, following symlinks. `None` when missing or unreadable
    /// (a dead link whose target is gone, or a file never created).
    pub size: Option<f64>,
    /// Whether the file is present and at least the completeness floor (90%) of
    /// its expected catalog size. A missing file is never complete.
    pub complete: bool,
}

/// List every selectable entry in the engine's models folder: model files
/// (.bin/.gguf/.ggml) for Whisper, directories for Parakeet and Moonshine, plus
/// symlinks to either. Hidden entries and in-flight `.partial` staging are
/// skipped. Returns an empty list when the folder does not exist yet.
#[tauri::command]
#[specta::specta]
pub fn list_model_entries(
    engine: Engine,
    app_handle: AppHandle,
) -> Result<Vec<ModelEntry>, ModelFolderError> {
    let models_dir = engine_models_path(&app_handle, engine)
        .map_err(|message| ModelFolderError::ReadFailed { message })?;
    let Ok(read_dir) = std::fs::read_dir(&models_dir) else {
        // The folder is created on first download/link; absence means empty.
        return Ok(Vec::new());
    };

    let mut entries = Vec::new();
    for dir_entry in read_dir.flatten() {
        let Ok(name) = dir_entry.file_name().into_string() else {
            continue;
        };
        if name.starts_with('.') || name.ends_with(".partial") {
            continue;
        }
        // `file_type` does not follow symlinks, so a link reads as a link
        // regardless of its target (which may be unreadable from here).
        let Ok(file_type) = dir_entry.file_type() else {
            continue;
        };
        let linked = file_type.is_symlink();
        let keep = match engine {
            Engine::Whispercpp => has_whisper_extension(&name) && (file_type.is_file() || linked),
            Engine::Parakeet | Engine::Moonshine => file_type.is_dir() || linked,
        };
        if keep {
            entries.push(ModelEntry { name, linked });
        }
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

fn has_whisper_extension(name: &str) -> bool {
    std::path::Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| WHISPER_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Remove one entry from the engine's models folder. A symlinked entry removes
/// only the link, never its target; a real entry is removed outright. The name
/// must be a single folder entry, so this can never reach outside the folder.
/// Succeeds when the entry is already gone.
#[tauri::command]
#[specta::specta]
pub fn delete_model_entry(
    engine: Engine,
    name: String,
    app_handle: AppHandle,
) -> Result<(), ModelFolderError> {
    if !is_contained_entry_name(&name) {
        return Err(ModelFolderError::InvalidEntryName {
            message: format!("Model entry name must be a single models-folder entry, got: {name}"),
        });
    }
    let path = engine_models_path(&app_handle, engine)
        .map_err(|message| ModelFolderError::DeleteFailed { message })?
        .join(&name);

    let Ok(meta) = path.symlink_metadata() else {
        // Already gone (or never existed): nothing to delete.
        return Ok(());
    };

    let outcome = if meta.file_type().is_symlink() {
        unlink_symlink(&path)
    } else if meta.is_dir() {
        std::fs::remove_dir_all(&path)
    } else {
        std::fs::remove_file(&path)
    };
    outcome.map_err(|e| ModelFolderError::DeleteFailed {
        message: format!("Could not delete \"{name}\": {e}"),
    })
}

/// Resolve an entry **through any symlink** and report each expected file's size
/// and completeness verdict. The webview passes the expected catalog sizes (it
/// owns the catalog); the 90% completeness rule lives here next to the stat, so
/// "what counts as a complete file on disk" has one owner shared with the
/// download integrity check (`is_size_complete`). An empty `filenames` means the
/// entry is itself the file (Whisper) and returns one element checked against
/// `expected_sizes[0]`; otherwise one element per filename (directory engines),
/// each checked against the aligned `expected_sizes`. A dead link reports
/// `size: None, complete: false`, so a linked-but-broken model reads as not
/// installed.
#[tauri::command]
#[specta::specta]
pub fn resolve_model_files(
    engine: Engine,
    name: String,
    filenames: Vec<String>,
    expected_sizes: Vec<f64>,
    app_handle: AppHandle,
) -> Result<Vec<ModelFileStatus>, ModelFolderError> {
    if !is_contained_entry_name(&name) {
        return Err(ModelFolderError::InvalidEntryName {
            message: format!("Model entry name must be a single models-folder entry, got: {name}"),
        });
    }
    let entry = engine_models_path(&app_handle, engine)
        .map_err(|message| ModelFolderError::ReadFailed { message })?
        .join(&name);

    // Empty `filenames` => the entry itself is the file (Whisper); otherwise one
    // file per name inside the entry directory.
    let sizes: Vec<Option<f64>> = if filenames.is_empty() {
        vec![file_size(&entry)]
    } else {
        filenames
            .iter()
            .map(|filename| {
                if is_contained_entry_name(filename) {
                    file_size(&entry.join(filename))
                } else {
                    None
                }
            })
            .collect()
    };

    // Pair each stat with its aligned expected size; a missing file (or a missing
    // expectation) is never complete.
    Ok(sizes
        .into_iter()
        .enumerate()
        .map(|(index, size)| {
            let complete = match (size, expected_sizes.get(index)) {
                (Some(actual), Some(&expected)) => is_size_complete(actual, expected),
                _ => false,
            };
            ModelFileStatus { size, complete }
        })
        .collect())
}

/// Clear whatever currently occupies a path before promoting onto it. Reads the
/// path's own type with `symlink_metadata` (never following a link), so a
/// colliding linked model is unlinked without touching its target, a stale real
/// entry is removed outright, and nothing there is a no-op. Mirrors the dispatch
/// in `delete_model_entry`.
fn clear_destination(path: &Path) -> std::io::Result<()> {
    let Ok(meta) = path.symlink_metadata() else {
        return Ok(());
    };
    if meta.file_type().is_symlink() {
        unlink_symlink(path)
    } else if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

/// Size of a file, following symlinks. `None` when it cannot be stat'd (missing,
/// or a dead link whose target is gone).
fn file_size(path: &Path) -> Option<f64> {
    std::fs::metadata(path).ok().map(|m| m.len() as f64)
}

/// Download a model into its engine folder, cancelable via
/// `cancel_download(download_id)`. Stages under `{entry}.partial`, streams each
/// file, integrity-checks it against the passed catalog size, then promotes the
/// staging to the canonical path with one rename. A cancel (or any error)
/// removes the staging via a `Drop` guard, so an interrupted run never leaves a
/// partial install for the selector to list. Reports cumulative progress
/// (bytes so far / grand total) on `on_progress`.
#[tauri::command]
#[specta::specta]
pub async fn download_model(
    engine: Engine,
    entry_name: String,
    files: Vec<ModelFileDownload>,
    download_id: String,
    on_progress: Channel<DownloadProgress>,
    app_handle: AppHandle,
    manager: State<'_, DownloadManager>,
) -> Result<(), ModelFolderError> {
    if !is_contained_entry_name(&entry_name) {
        return Err(ModelFolderError::InvalidEntryName {
            message: format!(
                "Model entry name must be a single models-folder entry, got: {entry_name}"
            ),
        });
    }
    if files.is_empty() {
        return Err(ModelFolderError::DownloadFailed {
            message: "No files to download for this model.".to_string(),
        });
    }
    let models_dir = engine_models_path(&app_handle, engine)
        .map_err(|message| ModelFolderError::DownloadFailed { message })?;
    let is_directory = engine != Engine::Whispercpp;
    let destination = models_dir.join(&entry_name);
    let staging = models_dir.join(format!("{entry_name}.partial"));

    // Run the whole staged download as one cancelable task: aborting it drops
    // the future, which drops the `StagingGuard` and removes the partial.
    let outcome = manager
        .run(
            &download_id,
            run_staged_download(
                models_dir,
                destination,
                staging,
                files,
                is_directory,
                on_progress,
            ),
        )
        .await;

    match outcome {
        Ok(inner) => inner,
        // A cancel aborts the task; the caller, which requested it, treats this
        // as a clean stop.
        Err(message) => Err(ModelFolderError::DownloadFailed { message }),
    }
}

/// Removes the staging path on drop unless disarmed. Disarmed only after a
/// successful promote, so an error return *or* a task abort cleans up.
struct StagingGuard {
    path: PathBuf,
    is_directory: bool,
    armed: bool,
}

impl StagingGuard {
    fn new(path: PathBuf, is_directory: bool) -> Self {
        Self {
            path,
            is_directory,
            armed: true,
        }
    }
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let _ = if self.is_directory {
            std::fs::remove_dir_all(&self.path)
        } else {
            std::fs::remove_file(&self.path)
        };
    }
}

async fn run_staged_download(
    models_dir: PathBuf,
    destination: PathBuf,
    staging: PathBuf,
    files: Vec<ModelFileDownload>,
    is_directory: bool,
    on_progress: Channel<DownloadProgress>,
) -> Result<(), ModelFolderError> {
    tokio::fs::create_dir_all(&models_dir)
        .await
        .map_err(|e| ModelFolderError::DownloadFailed {
            message: format!("create models folder: {e}"),
        })?;

    let mut guard = StagingGuard::new(staging.clone(), is_directory);
    let grand_total: f64 = files.iter().map(|f| f.size_bytes).sum();
    let mut completed: f64 = 0.0;

    if is_directory {
        // Clear any leftover staging from an interrupted run, then start clean.
        let _ = tokio::fs::remove_dir_all(&staging).await;
        tokio::fs::create_dir_all(&staging).await.map_err(|e| {
            ModelFolderError::DownloadFailed {
                message: format!("create staging directory: {e}"),
            }
        })?;
        for file in &files {
            if !is_contained_entry_name(&file.filename) {
                return Err(ModelFolderError::InvalidEntryName {
                    message: format!(
                        "Model file name must be a single entry, got: {}",
                        file.filename
                    ),
                });
            }
            let file_path = staging.join(&file.filename);
            let base = completed;
            let received = stream_to_file(&file.url, &path_str(&file_path)?, |bytes| {
                let _ = on_progress.send(DownloadProgress::new(base + bytes as f64, grand_total));
            })
            .await
            .map_err(|message| ModelFolderError::DownloadFailed { message })?;
            ensure_complete(received, file.size_bytes)?;
            completed += file.size_bytes;
        }
    } else {
        let file = &files[0];
        let received = stream_to_file(&file.url, &path_str(&staging)?, |bytes| {
            let _ = on_progress.send(DownloadProgress::new(bytes as f64, grand_total));
        })
        .await
        .map_err(|message| ModelFolderError::DownloadFailed { message })?;
        ensure_complete(received, file.size_bytes)?;
    }

    // Promote: clear any stale entry at the canonical path, then rename staging
    // onto it in one move. The stale entry may be a colliding symlink (a linked
    // model the user named like this catalog one), so clear it by its own type
    // rather than the engine's, and unlink a link instead of following it.
    clear_destination(&destination).map_err(|e| ModelFolderError::DownloadFailed {
        message: format!("replace existing model: {e}"),
    })?;
    tokio::fs::rename(&staging, &destination)
        .await
        .map_err(|e| ModelFolderError::DownloadFailed {
            message: format!("promote downloaded model: {e}"),
        })?;
    guard.disarm();
    Ok(())
}

/// A file at least this fraction of its catalog size counts as complete. A
/// dropped connection can leave a whisper.cpp `.bin` that still loads but
/// transcribes garbage, or ONNX files that fail to load; the floor rejects them.
const COMPLETENESS_FLOOR: f64 = 0.9;

/// The single completeness rule, shared by the download integrity check
/// (`ensure_complete`) and the read-path verdict (`resolve_model_files`), so the
/// threshold has one owner instead of a copy on each side of the IPC boundary.
fn is_size_complete(received: f64, expected: f64) -> bool {
    received >= expected * COMPLETENESS_FLOOR
}

/// Reject a file that finished below the completeness floor of its catalog size:
/// whisper.cpp loads a truncated `.bin` but transcribes garbage, and ONNX files
/// fail to load.
fn ensure_complete(received: u64, expected: f64) -> Result<(), ModelFolderError> {
    if is_size_complete(received as f64, expected) {
        return Ok(());
    }
    Err(ModelFolderError::DownloadIncomplete {
        message: format!(
            "Download incomplete: received {}MB but expected {}MB. Please check your network connection and try again.",
            received / 1_000_000,
            (expected as u64) / 1_000_000,
        ),
    })
}

fn path_str(path: &Path) -> Result<String, ModelFolderError> {
    path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| ModelFolderError::DownloadFailed {
            message: format!("model path is not valid UTF-8: {}", path.display()),
        })
}

/// Create the engine's models folder if needed and open it in the OS file
/// manager, so the user can drop in or remove models by hand.
#[tauri::command]
#[specta::specta]
pub fn reveal_models_folder(engine: Engine, app_handle: AppHandle) -> Result<(), ModelFolderError> {
    let models_dir = engine_models_path(&app_handle, engine)
        .map_err(|message| ModelFolderError::RevealFailed { message })?;
    std::fs::create_dir_all(&models_dir).map_err(|e| ModelFolderError::RevealFailed {
        message: format!("create models folder: {e}"),
    })?;
    app_handle
        .opener()
        .open_path(models_dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| ModelFolderError::RevealFailed {
            message: format!("open models folder: {e}"),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "whispering-folder-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn whisper_extension_is_case_insensitive_and_specific() {
        for ok in ["ggml-small.bin", "model.gguf", "X.GGML", "a.BiN"] {
            assert!(has_whisper_extension(ok), "{ok}");
        }
        for no in ["notes.txt", "model", "archive.zip", ".bin"] {
            // ".bin" has no stem, so `extension()` is `None`: not a model file.
            assert!(!has_whisper_extension(no), "{no}");
        }
    }

    #[test]
    fn ensure_complete_uses_the_ninety_percent_floor() {
        // Exactly 90% passes; just under fails.
        assert!(ensure_complete(900, 1000.0).is_ok());
        assert!(ensure_complete(899, 1000.0).is_err());
        // A larger-than-catalog file is fine.
        assert!(ensure_complete(1200, 1000.0).is_ok());
    }

    #[test]
    fn is_size_complete_is_the_single_floor_shared_by_both_paths() {
        // The same rule `ensure_complete` (download) and `resolve_model_files`
        // (read) both call, so the threshold can never drift between them.
        assert!(is_size_complete(900.0, 1000.0));
        assert!(!is_size_complete(899.0, 1000.0));
        assert!(is_size_complete(1200.0, 1000.0));
    }

    #[test]
    fn file_size_follows_a_symlink_and_is_none_for_a_dead_link() {
        let dir = tmp();
        let target = dir.join("real.bin");
        fs::write(&target, b"twelve bytes").unwrap();
        assert_eq!(file_size(&target), Some(12.0));

        #[cfg(unix)]
        {
            let link = dir.join("link.bin");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            // A live link reports the target's size...
            assert_eq!(file_size(&link), Some(12.0));
            // ...and a dead link (target removed) reports nothing, so a
            // linked-but-broken model reads as not installed.
            fs::remove_file(&target).unwrap();
            assert_eq!(file_size(&link), None);
        }

        assert_eq!(file_size(&dir.join("missing")), None);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_destination_unlinks_a_colliding_link_without_following_it() {
        let dir = tmp();
        // A real entry is removed outright.
        let real = dir.join("real.bin");
        fs::write(&real, b"bytes").unwrap();
        clear_destination(&real).unwrap();
        assert!(!real.exists(), "a real entry must be removed");

        // Nothing there is a no-op.
        clear_destination(&dir.join("missing")).unwrap();

        #[cfg(unix)]
        {
            // A colliding symlink is unlinked, never followed: the target survives
            // so promoting a catalog download over a same-named linked model can
            // never delete the user's bytes.
            let target_dir = dir.join("target");
            fs::create_dir_all(&target_dir).unwrap();
            fs::write(target_dir.join("keep.txt"), b"keep").unwrap();
            let link = dir.join("link");
            std::os::unix::fs::symlink(&target_dir, &link).unwrap();

            clear_destination(&link).unwrap();
            assert!(!link.symlink_metadata().is_ok(), "the link must be gone");
            assert!(
                target_dir.join("keep.txt").exists(),
                "the link's target must be untouched"
            );
        }

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn staging_guard_removes_on_drop_but_not_after_disarm() {
        // Armed: dropping removes the staging file (the error/cancel path).
        let dir = tmp();
        let staging = dir.join("model.partial");
        fs::write(&staging, b"x").unwrap();
        {
            let _guard = StagingGuard::new(staging.clone(), false);
        }
        assert!(!staging.exists(), "armed guard must remove staging on drop");

        // Disarmed: dropping leaves it (the successful-promote path).
        let staging_dir = dir.join("model-dir.partial");
        fs::create_dir_all(&staging_dir).unwrap();
        {
            let mut guard = StagingGuard::new(staging_dir.clone(), true);
            guard.disarm();
        }
        assert!(
            staging_dir.exists(),
            "disarmed guard must leave the promoted entry alone"
        );

        fs::remove_dir_all(&dir).ok();
    }
}
