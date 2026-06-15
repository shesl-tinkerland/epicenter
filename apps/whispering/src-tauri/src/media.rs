use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum MediaPlayer {
    Music,
    Spotify,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MediaControlFailure {
    player: MediaPlayer,
    message: String,
    permission_denied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PauseActiveMediaOutcome {
    paused: Vec<MediaPlayer>,
    failures: Vec<MediaControlFailure>,
}

impl MediaPlayer {
    fn app_name(self) -> &'static str {
        match self {
            MediaPlayer::Music => "Music",
            MediaPlayer::Spotify => "Spotify",
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn pause_active_media() -> Result<PauseActiveMediaOutcome, String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(pause_active_media_sync)
            .await
            .map_err(|e| format!("Failed to pause active media: {}", e))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(PauseActiveMediaOutcome {
            paused: Vec::new(),
            failures: Vec::new(),
        })
    }
}

#[tauri::command]
#[specta::specta]
pub async fn resume_media(players: Vec<MediaPlayer>) -> Result<Vec<MediaControlFailure>, String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(move || resume_media_sync(players))
            .await
            .map_err(|e| format!("Failed to resume media: {}", e))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = players;
        Ok(Vec::new())
    }
}

#[cfg(target_os = "macos")]
fn pause_active_media_sync() -> Result<PauseActiveMediaOutcome, String> {
    let mut paused = Vec::new();
    let mut failures = Vec::new();

    for player in [MediaPlayer::Music, MediaPlayer::Spotify] {
        match pause_player(player) {
            Ok(true) => paused.push(player),
            Ok(false) => {}
            Err(message) => failures.push(failure(player, message)),
        }
    }

    Ok(PauseActiveMediaOutcome { paused, failures })
}

#[cfg(target_os = "macos")]
fn resume_media_sync(players: Vec<MediaPlayer>) -> Result<Vec<MediaControlFailure>, String> {
    let mut failures = Vec::new();

    for player in players {
        if let Err(message) = resume_player(player) {
            failures.push(failure(player, message));
        }
    }

    Ok(failures)
}

#[cfg(target_os = "macos")]
fn pause_player(player: MediaPlayer) -> Result<bool, String> {
    if !is_app_running(player.app_name()) {
        return Ok(false);
    }

    let script = format!(
        r#"
tell application "{app_name}"
	if player state is playing then
		pause
		return "paused"
	end if
end tell
return "idle"
"#,
        app_name = player.app_name()
    );

    run_osascript(&script).map(|output| output.trim() == "paused")
}

#[cfg(target_os = "macos")]
fn resume_player(player: MediaPlayer) -> Result<(), String> {
    // The FE only asks us to resume players we actually paused, so this guard
    // only fires when the user quit the app mid-recording. It still matters:
    // `tell application "X" to play` would cold-launch a quit app otherwise.
    if !is_app_running(player.app_name()) {
        return Ok(());
    }

    let script = format!(
        r#"
tell application "{app_name}" to play
"#,
        app_name = player.app_name()
    );

    run_osascript(&script).map(|_| ())
}

#[cfg(target_os = "macos")]
fn is_app_running(app_name: &str) -> bool {
    use std::process::Command;

    Command::new("/usr/bin/pgrep")
        .args(["-x", app_name])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn run_osascript(script: &str) -> Result<String, String> {
    use std::process::Command;

    let output = Command::new("/usr/bin/osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        return Err(format!(
            "osascript exited with code {:?}",
            output.status.code()
        ));
    }

    Err(stderr)
}

#[cfg(target_os = "macos")]
fn failure(player: MediaPlayer, message: String) -> MediaControlFailure {
    // macOS Automation denial surfaces as "Not authorized to send Apple
    // events ... (-1743)". Match only those two reliable markers: a looser
    // "permission" substring would mislabel an unrelated error and then latch
    // the one-time permission hint shut for the rest of the session.
    let lower = message.to_lowercase();
    let permission_denied = lower.contains("not authorized") || lower.contains("-1743");
    MediaControlFailure {
        player,
        permission_denied,
        message,
    }
}
