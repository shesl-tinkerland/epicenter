//! Pause and resume system media playback around recording.
//!
//! The frontend `recordingMedia` chain calls `pause_playback` on capture start
//! and `resume_playback` on capture end, trading opaque `String` session tokens:
//! `pause_playback` returns a token for each session it paused, and the frontend
//! hands that same set back to `resume_playback`. Token contents are
//! platform-private (macOS output-active bundle ids, Windows AUMIDs, Linux MPRIS
//! bus names) and the frontend never interprets them.
//!
//! Recording never waits on, and never fails because of, playback control: each
//! command returns a `Result` the caller fires and forgets. One platform module
//! is compiled per target; unsupported targets are silent no-ops.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// Pause every system media session currently playing. Returns one opaque token
/// per session paused, to hand back to `resume_playback`. Pausing is gated to
/// never *start* playback: only sessions observed playing are touched, and the
/// dedicated pause command (never a play/pause toggle) is sent.
#[tauri::command]
#[specta::specta]
pub async fn pause_playback() -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        macos::pause_playing().await
    }
    #[cfg(target_os = "windows")]
    {
        windows::pause_playing().await
    }
    #[cfg(target_os = "linux")]
    {
        linux::pause_playing().await
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Ok(Vec::new())
    }
}

/// Resume the sessions named by `sessions`, which must be tokens returned by a
/// prior `pause_playback`. A session that vanished, was already resumed by the
/// user, or can't be resumed is silently skipped. Safety rule: we only ever send
/// *play* to a session we personally paused.
#[tauri::command]
#[specta::specta]
pub async fn resume_playback(sessions: Vec<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::resume(sessions).await
    }
    #[cfg(target_os = "windows")]
    {
        windows::resume(sessions).await
    }
    #[cfg(target_os = "linux")]
    {
        linux::resume(sessions).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = sessions;
        Ok(())
    }
}
