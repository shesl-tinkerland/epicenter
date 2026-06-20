//! Link a model already on disk into the engine's models folder.
//!
//! "Bring your own model" without copying bytes: the user picks a file or
//! directory anywhere on disk (a download they already have, a fine-tune, a
//! model shared by another tool) and this creates a symlink entry inside
//! `{app_data}/models/{engine}/`. The existing loaders follow symlinks
//! natively, so a linked entry loads exactly like a downloaded one.
//!
//! Why this lives in Rust and not the webview `plugin-fs`: the picked target
//! lives outside the webview's `fs:scope`, so JS can neither stat it to
//! validate its shape nor create a link to it. Rust is also the trust
//! boundary, so it validates the engine shape strictly here rather than
//! trusting the caller. Deletion stays where it is (`local-model-folder.ts`),
//! which already removes only the link, never its target.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use thiserror::Error;

use super::config::Engine;
use super::model_cache::{engine_models_path, is_contained_entry_name, parse_moonshine_variant};

/// Extensions a Whisper model file may carry. The single source of truth for
/// the listing filter (`model_folder::list_model_entries`) and import-time
/// shape validation; whisper.cpp accepts GGML/GGUF.
pub(crate) const WHISPER_EXTENSIONS: [&str; 3] = ["bin", "gguf", "ggml"];

#[derive(Error, Debug, Serialize, Deserialize, specta::Type)]
#[serde(tag = "name")]
pub enum ModelImportError {
    /// The chosen registry entry name is not a single folder entry, or (for
    /// Moonshine) does not match the `moonshine-{variant}-{lang}` convention.
    #[error("{message}")]
    InvalidEntryName { message: String },

    /// A real, app-managed model with the chosen name already occupies the
    /// folder. Refused rather than clobbered so linking never deletes
    /// downloaded bytes. Carries the colliding name (`entry`, not `name`, which
    /// is the serde discriminant) so the UI can guide the user to delete that
    /// existing entry first.
    #[error("\"{entry}\" already exists in Whispering")]
    EntryExists { entry: String },

    /// The picked file/directory does not have the exact shape the engine's
    /// loader needs.
    #[error("{message}")]
    IncompatibleModel { message: String },

    /// Creating (or replacing) the symlink failed.
    #[error("{message}")]
    LinkFailed { message: String },
}

/// Validate the registry entry name. Containment mirrors `model_path_for`
/// (a single folder entry, no separators or traversal); Moonshine additionally
/// must match the naming convention the loader derives its variant from.
fn validate_entry_name(engine: Engine, name: &str) -> Result<(), ModelImportError> {
    if name.is_empty() || !is_contained_entry_name(name) {
        return Err(ModelImportError::InvalidEntryName {
            message: format!("Model entry name must be a single models-folder entry, got: {name}"),
        });
    }
    if engine == Engine::Moonshine {
        parse_moonshine_variant(name).map_err(|_| ModelImportError::InvalidEntryName {
            message: format!(
                "Moonshine entries must be named moonshine-{{tiny|base}}-{{lang}} (e.g. moonshine-base-en) so the loader can read the variant from the name. Rename the folder, got: {name}"
            ),
        })?;
    }
    Ok(())
}

fn require_dir(source: &Path) -> Result<(), ModelImportError> {
    if source.is_dir() {
        return Ok(());
    }
    Err(ModelImportError::IncompatibleModel {
        message: "This engine loads a model directory. Pick the folder that holds the model files."
            .to_string(),
    })
}

fn require_file(source: &Path, file: &str) -> Result<(), ModelImportError> {
    if source.join(file).is_file() {
        return Ok(());
    }
    Err(ModelImportError::IncompatibleModel {
        message: format!("The model folder is missing a required file: {file}"),
    })
}

/// Require at least one of a set of interchangeable filenames (e.g. an int8 or
/// fp32 variant the loader falls back between). `label` names the role for the
/// error message.
fn require_any(source: &Path, files: &[&str], label: &str) -> Result<(), ModelImportError> {
    if files.iter().any(|file| source.join(file).is_file()) {
        return Ok(());
    }
    Err(ModelImportError::IncompatibleModel {
        message: format!(
            "The model folder is missing the {label} file ({}).",
            files.join(" or ")
        ),
    })
}

/// Strict per-engine shape validation, matching exactly what each transcribe-rs
/// loader opens. Whisper is a single GGML/GGUF file; Parakeet and Moonshine are
/// directories with the loader's required files. Parakeet's encoder/decoder
/// accept the int8 or fp32 name because `ParakeetModel::load` falls back
/// between them; `nemo128.onnx` and `vocab.txt` are fixed.
fn validate_source_shape(engine: Engine, source: &Path) -> Result<(), ModelImportError> {
    match engine {
        Engine::Whispercpp => {
            if !source.is_file() {
                return Err(ModelImportError::IncompatibleModel {
                    message: "Whisper models are a single file. Pick a .bin, .gguf, or .ggml file."
                        .to_string(),
                });
            }
            let ext_ok = source
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| WHISPER_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
                .unwrap_or(false);
            if !ext_ok {
                return Err(ModelImportError::IncompatibleModel {
                    message: "Whisper models must be a .bin, .gguf, or .ggml file.".to_string(),
                });
            }
            Ok(())
        }
        Engine::Parakeet => {
            require_dir(source)?;
            require_any(
                source,
                &["encoder-model.int8.onnx", "encoder-model.onnx"],
                "Parakeet encoder",
            )?;
            require_any(
                source,
                &["decoder_joint-model.int8.onnx", "decoder_joint-model.onnx"],
                "Parakeet decoder",
            )?;
            require_file(source, "nemo128.onnx")?;
            require_file(source, "vocab.txt")?;
            Ok(())
        }
        Engine::Moonshine => {
            require_dir(source)?;
            require_file(source, "encoder_model.onnx")?;
            require_file(source, "decoder_model_merged.onnx")?;
            require_file(source, "tokenizer.json")?;
            Ok(())
        }
    }
}

/// Unlink a symlink entry without touching its target. On unix `remove_file`
/// unlinks a symlink even when it points at a directory; on Windows a directory
/// symlink needs `remove_dir`, so try the file form first and fall back. Shared
/// with `model_folder::delete_model_entry`, which unlinks the same way.
pub(crate) fn unlink_symlink(link: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        std::fs::remove_file(link).or_else(|_| std::fs::remove_dir(link))
    }
    #[cfg(not(windows))]
    {
        std::fs::remove_file(link)
    }
}

/// Clear whatever already occupies the link path. A stale symlink (re-linking)
/// is unlinked; a real app-managed file/dir is refused rather than deleted, so
/// linking can never destroy downloaded bytes. Nothing there is a no-op.
fn clear_link_path(link: &Path) -> Result<(), ModelImportError> {
    let Ok(meta) = link.symlink_metadata() else {
        return Ok(());
    };
    if meta.file_type().is_symlink() {
        return unlink_symlink(link).map_err(|e| ModelImportError::LinkFailed {
            message: format!("replace existing link: {e}"),
        });
    }
    Err(ModelImportError::EntryExists {
        entry: link
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string(),
    })
}

#[cfg(unix)]
fn create_symlink(source: &Path, link: &Path, _is_dir: bool) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, link)
}

#[cfg(windows)]
fn create_symlink(source: &Path, link: &Path, is_dir: bool) -> std::io::Result<()> {
    if is_dir {
        std::os::windows::fs::symlink_dir(source, link)
    } else {
        std::os::windows::fs::symlink_file(source, link)
    }
}

/// Link a file or directory already on disk into the engine's models folder as
/// `entry_name`. Validates the name and the source's engine shape strictly,
/// then symlinks. Replaces a stale link of the same name; refuses to clobber a
/// real (app-managed) entry. The frontend stores `entry_name` as the selection
/// just like a downloaded model.
#[tauri::command]
#[specta::specta]
pub fn link_local_model(
    engine: Engine,
    entry_name: String,
    source_path: String,
    app_handle: AppHandle,
) -> Result<(), ModelImportError> {
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(ModelImportError::IncompatibleModel {
            message: format!("The selected path no longer exists: {source_path}"),
        });
    }
    validate_entry_name(engine, &entry_name)?;
    validate_source_shape(engine, &source)?;

    let models_dir = engine_models_path(&app_handle, engine)
        .map_err(|message| ModelImportError::LinkFailed { message })?;
    std::fs::create_dir_all(&models_dir).map_err(|e| ModelImportError::LinkFailed {
        message: format!("create models folder: {e}"),
    })?;

    let link = models_dir.join(&entry_name);
    clear_link_path(&link)?;

    let is_dir = engine != Engine::Whispercpp;
    create_symlink(&source, &link, is_dir).map_err(|e| ModelImportError::LinkFailed {
        message: format!(
            "Could not create the link. On Windows this needs Developer Mode or running as admin. ({e})"
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "whispering-link-test-{}-{:?}",
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
    fn entry_name_rejects_traversal_and_separators() {
        for bad in ["", ".", "..", "a/b", "a\\b"] {
            assert!(
                validate_entry_name(Engine::Whispercpp, bad).is_err(),
                "{bad:?}"
            );
        }
        assert!(validate_entry_name(Engine::Whispercpp, "my-model.bin").is_ok());
    }

    #[test]
    fn entry_name_enforces_moonshine_naming() {
        assert!(validate_entry_name(Engine::Moonshine, "moonshine-base-en").is_ok());
        assert!(validate_entry_name(Engine::Moonshine, "moonshine-tiny-en").is_ok());
        assert!(validate_entry_name(Engine::Moonshine, "my-moonshine").is_err());
        // Parakeet has no naming convention, so any single entry is fine.
        assert!(validate_entry_name(Engine::Parakeet, "whatever-folder").is_ok());
    }

    #[test]
    fn whisper_shape_accepts_known_extensions_only() {
        let dir = tmp();
        let bin = dir.join("ggml-small.bin");
        fs::write(&bin, b"x").unwrap();
        assert!(validate_source_shape(Engine::Whispercpp, &bin).is_ok());

        let txt = dir.join("notes.txt");
        fs::write(&txt, b"x").unwrap();
        assert!(validate_source_shape(Engine::Whispercpp, &txt).is_err());

        // A directory is not a Whisper model.
        assert!(validate_source_shape(Engine::Whispercpp, &dir).is_err());
    }

    #[test]
    fn parakeet_shape_requires_loader_files_with_int8_or_fp32() {
        let dir = tmp();
        // Missing everything.
        assert!(validate_source_shape(Engine::Parakeet, &dir).is_err());
        for f in [
            "encoder-model.int8.onnx",
            "decoder_joint-model.int8.onnx",
            "nemo128.onnx",
            "vocab.txt",
        ] {
            fs::write(dir.join(f), b"x").unwrap();
        }
        assert!(validate_source_shape(Engine::Parakeet, &dir).is_ok());

        // fp32 encoder/decoder names also satisfy the loader fallback.
        let dir2 = tmp();
        for f in [
            "encoder-model.onnx",
            "decoder_joint-model.onnx",
            "nemo128.onnx",
            "vocab.txt",
        ] {
            fs::write(dir2.join(f), b"x").unwrap();
        }
        assert!(validate_source_shape(Engine::Parakeet, &dir2).is_ok());
    }

    #[test]
    fn moonshine_shape_requires_exact_files() {
        let dir = tmp();
        fs::write(dir.join("encoder_model.onnx"), b"x").unwrap();
        fs::write(dir.join("decoder_model_merged.onnx"), b"x").unwrap();
        assert!(validate_source_shape(Engine::Moonshine, &dir).is_err()); // no tokenizer
        fs::write(dir.join("tokenizer.json"), b"x").unwrap();
        assert!(validate_source_shape(Engine::Moonshine, &dir).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn clear_link_path_unlinks_symlink_but_keeps_target() {
        let dir = tmp();
        let target = dir.join("real.bin");
        fs::write(&target, b"bytes").unwrap();
        let link = dir.join("link.bin");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        clear_link_path(&link).unwrap();
        assert!(!link.symlink_metadata().is_ok(), "link should be gone");
        assert!(target.is_file(), "target bytes must survive");
        assert_eq!(fs::read(&target).unwrap(), b"bytes");
    }

    #[test]
    fn clear_link_path_refuses_to_clobber_a_real_entry() {
        let dir = tmp();
        let real = dir.join("downloaded.bin");
        fs::write(&real, b"bytes").unwrap();
        let err = clear_link_path(&real).unwrap_err();
        assert!(
            matches!(err, ModelImportError::EntryExists { ref entry } if entry == "downloaded.bin"),
            "collision must surface as EntryExists carrying the name, got {err:?}"
        );
        assert!(
            real.is_file(),
            "a real download must never be deleted by linking"
        );
    }
}
