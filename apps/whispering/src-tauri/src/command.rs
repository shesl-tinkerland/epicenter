#[cfg(target_os = "macos")]
use std::process::Command;

/// Open macOS Accessibility settings.
///
/// This is intentionally a fixed command instead of a general command
/// runner. The app only needs this one OS handoff, so the frontend should
/// not receive shell or process execution privileges.
#[tauri::command]
#[specta::specta]
pub async fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Deep-link straight to Privacy & Security > Accessibility. This
        // `x-apple.systempreferences:` scheme is honored by System Settings from
        // Ventura through Sequoia; the older `x-apple.systemsettings:` form was
        // not claimed by any app and failed with kLSApplicationNotFoundErr, so
        // the button only ever hit its manual-instructions fallback.
        let status = Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .status()
            .map_err(|e| format!("Failed to open accessibility settings: {}", e))?;

        if status.success() {
            return Ok(());
        }

        return Err(format!(
            "Failed to open accessibility settings: exit code {:?}",
            status.code()
        ));
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Accessibility settings are only available on macOS.".to_string())
    }
}
