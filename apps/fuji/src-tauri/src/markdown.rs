use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};
use tempfile::NamedTempFile;

#[derive(serde::Deserialize, serde::Serialize)]
pub struct MarkdownFile {
    filename: String,
    content: String,
}

fn validate_leaf_filename(filename: &str) -> Result<&str, String> {
    if filename.is_empty() {
        return Err("Filename cannot be empty".to_string());
    }

    let path = Path::new(filename);
    let mut components = path.components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(filename),
        _ => Err(format!("Invalid filename: {}", filename)),
    }
}

fn validate_markdown_directory(app: &AppHandle, directory: &str) -> Result<PathBuf, String> {
    let requested = PathBuf::from(directory);
    if !requested.is_absolute() {
        return Err(format!("Directory must be absolute: {}", directory));
    }

    let expected = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {}", error))?
        .join("markdown");

    if requested != expected {
        return Err(format!(
            "Markdown directory must be the app data markdown directory: {}",
            expected.display()
        ));
    }

    Ok(requested)
}

#[tauri::command]
pub async fn write_markdown_files(
    app: AppHandle,
    directory: String,
    files: Vec<MarkdownFile>,
) -> Result<(), String> {
    let dir_path = validate_markdown_directory(&app, &directory)?;

    tokio::task::spawn_blocking(move || {
        let validated: Vec<&str> = {
            let mut seen = HashSet::with_capacity(files.len());
            let mut names = Vec::with_capacity(files.len());
            for file in &files {
                let name = validate_leaf_filename(&file.filename)?;
                if !name.ends_with(".md") {
                    return Err(format!("Markdown filename must end with .md: {}", name));
                }
                if !seen.insert(name) {
                    return Err(format!("Duplicate filename in request: {}", name));
                }
                names.push(name);
            }
            names
        };

        fs::create_dir_all(&dir_path).map_err(|error| {
            format!(
                "Failed to create markdown directory {}: {}",
                dir_path.display(),
                error
            )
        })?;

        for (file, filename) in files.iter().zip(validated.iter()) {
            let path = dir_path.join(filename);
            let mut temp = NamedTempFile::new_in(&dir_path).map_err(|error| {
                format!("Failed to create temp file for {}: {}", filename, error)
            })?;

            temp.write_all(file.content.as_bytes())
                .map_err(|error| format!("Failed to write {}: {}", filename, error))?;
            temp.persist(&path)
                .map_err(|error| format!("Failed to persist {}: {}", filename, error.error))?;
        }

        Ok(())
    })
    .await
    .map_err(|error| format!("Task join error: {}", error))?
}

#[tauri::command]
pub async fn read_markdown_files(
    app: AppHandle,
    directory: String,
) -> Result<Vec<MarkdownFile>, String> {
    let dir_path = validate_markdown_directory(&app, &directory)?;

    tokio::task::spawn_blocking(move || {
        if !dir_path.exists() {
            return Ok(Vec::new());
        }

        let mut files = Vec::new();
        let entries = fs::read_dir(&dir_path).map_err(|error| {
            format!(
                "Failed to read markdown directory {}: {}",
                dir_path.display(),
                error
            )
        })?;

        for entry in entries {
            let entry =
                entry.map_err(|error| format!("Failed to read directory entry: {}", error))?;
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                continue;
            }

            let filename = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| format!("Invalid UTF-8 markdown filename: {}", path.display()))?
                .to_string();
            validate_leaf_filename(&filename)?;

            let content = fs::read_to_string(&path)
                .map_err(|error| format!("Failed to read {}: {}", path.display(), error))?;
            files.push(MarkdownFile { filename, content });
        }

        files.sort_by(|left, right| left.filename.cmp(&right.filename));
        Ok(files)
    })
    .await
    .map_err(|error| format!("Task join error: {}", error))?
}
