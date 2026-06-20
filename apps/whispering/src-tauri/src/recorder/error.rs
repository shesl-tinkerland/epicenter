//! Structured recorder failures that cross the IPC boundary.
//!
//! Every recorder command returns `Result<T, RecorderError>`. The enum is
//! internally tagged (`{ "name": "...", "message": "..." }`) so the TypeScript
//! side switches on `error.name`.
//!
//! Only three variants, because the frontend only distinguishes three cases: a
//! microphone permission denial (route the user to grant access), a missing
//! input device (ask them to connect one), and everything else, which the
//! frontend labels by the command that failed (init/start/stop) and shows the
//! message for. A finer taxonomy (io vs config vs internal) was deliberately
//! not modeled: the frontend would discard the distinction, so it would be a
//! decorative name on a string. The detail still travels, in `message`.

use std::fmt::Display;

use cpal::{BuildStreamError, DevicesError, SupportedStreamConfigsError};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug, Serialize, Deserialize, specta::Type)]
#[serde(tag = "name")]
pub enum RecorderError {
    /// The OS refused microphone access. The frontend checks microphone
    /// permission before recording, so this is the stream-open fallback for a
    /// denial that slips past that gate (e.g. a declined first-run prompt).
    #[error("{message}")]
    PermissionDenied { message: String },

    /// No usable input device: none selected and no default, the named device
    /// is gone, cpal reports the device unavailable mid-open, or the device
    /// yields no input configurations at all (query errors or returns empty).
    #[error("{message}")]
    NoInputDevice { message: String },

    /// Any other recording failure (device config, stream build, filesystem,
    /// session lifecycle, internal). The frontend does not branch on these.
    #[error("{message}")]
    Failed { message: String },
}

impl RecorderError {
    pub(crate) fn no_input_device(message: impl Into<String>) -> Self {
        Self::NoInputDevice {
            message: message.into(),
        }
    }

    pub(crate) fn failed(message: impl Into<String>) -> Self {
        Self::Failed {
            message: message.into(),
        }
    }

    /// Classify a cpal stream/device error.
    ///
    /// cpal types "device gone" as `DeviceNotAvailable` but does not type
    /// "permission denied": a denial only arrives as a `BackendSpecific`
    /// description string. So the device case is matched by variant
    /// (locale-proof), and only the permission signal is recovered from text.
    /// That text match is the one irreducible heuristic here. cpal refuses to
    /// type it, and the frontend's pre-record permission check is the primary
    /// gate regardless, so this only catches a denial surfacing at stream-open.
    pub(crate) fn classify_cpal(context: &str, err: impl CpalStreamError + Display) -> Self {
        let message = format!("{context}: {err}");
        if err.is_device_unavailable() {
            return Self::NoInputDevice { message };
        }
        if let Some(description) = err.backend_description() {
            let lower = description.to_lowercase();
            if lower.contains("access is denied")
                || lower.contains("permission")
                || lower.contains("0x80070005")
            {
                return Self::PermissionDenied { message };
            }
        }
        Self::Failed { message }
    }
}

/// Bridges cpal's stream/device error types, which share `DeviceNotAvailable`
/// and `BackendSpecific { err }` shapes but no common trait, so `classify_cpal`
/// can match the device case by variant instead of by string. `DevicesError` is
/// the exception: it has only a `BackendSpecific` arm, so it can never report an
/// unavailable device.
pub(crate) trait CpalStreamError {
    fn is_device_unavailable(&self) -> bool;
    fn backend_description(&self) -> Option<&str>;
}

impl CpalStreamError for DevicesError {
    fn is_device_unavailable(&self) -> bool {
        false
    }
    fn backend_description(&self) -> Option<&str> {
        let DevicesError::BackendSpecific { err } = self;
        Some(&err.description)
    }
}

impl CpalStreamError for SupportedStreamConfigsError {
    fn is_device_unavailable(&self) -> bool {
        matches!(self, SupportedStreamConfigsError::DeviceNotAvailable)
    }
    fn backend_description(&self) -> Option<&str> {
        match self {
            SupportedStreamConfigsError::BackendSpecific { err } => Some(&err.description),
            _ => None,
        }
    }
}

impl CpalStreamError for BuildStreamError {
    fn is_device_unavailable(&self) -> bool {
        matches!(self, BuildStreamError::DeviceNotAvailable)
    }
    fn backend_description(&self) -> Option<&str> {
        match self {
            BuildStreamError::BackendSpecific { err } => Some(&err.description),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cpal::BackendSpecificError;

    fn backend(description: &str) -> BackendSpecificError {
        BackendSpecificError {
            description: description.to_string(),
        }
    }

    fn name_of(err: &RecorderError) -> &'static str {
        match err {
            RecorderError::PermissionDenied { .. } => "PermissionDenied",
            RecorderError::NoInputDevice { .. } => "NoInputDevice",
            RecorderError::Failed { .. } => "Failed",
        }
    }

    // The typed device-gone variant must classify as NoInputDevice, regardless
    // of which cpal error enum carries it.
    #[test]
    fn typed_device_not_available_is_no_input_device() {
        let from_configs = RecorderError::classify_cpal(
            "ctx",
            SupportedStreamConfigsError::DeviceNotAvailable,
        );
        assert_eq!(name_of(&from_configs), "NoInputDevice");

        let from_build =
            RecorderError::classify_cpal("ctx", BuildStreamError::DeviceNotAvailable);
        assert_eq!(name_of(&from_build), "NoInputDevice");
    }

    // The one irreducible heuristic: a permission denial only arrives as a
    // BackendSpecific description string. Windows WASAPI Initialize surfaces
    // E_ACCESSDENIED here as "... access is denied ... (0x80070005)".
    #[test]
    fn backend_permission_strings_are_permission_denied() {
        for description in [
            "The device access is denied",
            "Some failure: permission to access the microphone",
            "WASAPI error 0x80070005",
            // Case-insensitive: classify lowercases before matching.
            "ACCESS IS DENIED",
        ] {
            let err = RecorderError::classify_cpal(
                "ctx",
                BuildStreamError::BackendSpecific { err: backend(description) },
            );
            assert_eq!(
                name_of(&err),
                "PermissionDenied",
                "expected PermissionDenied for {description:?}"
            );
        }
    }

    // A BackendSpecific failure with no permission signal is the catch-all.
    // This is also the macOS reality for supported_input_configs failures,
    // which cpal 0.16 always returns as BackendSpecific (never the typed
    // DeviceNotAvailable variant).
    #[test]
    fn backend_without_permission_signal_is_failed() {
        let err = RecorderError::classify_cpal(
            "Failed to query input configs",
            SupportedStreamConfigsError::BackendSpecific {
                err: backend("An unknown error unknown to the coreaudio-rs API occurred"),
            },
        );
        assert_eq!(name_of(&err), "Failed");
    }

    // DevicesError has only a BackendSpecific arm, so it can never report an
    // unavailable device by variant: it must fall through to the text check.
    #[test]
    fn devices_error_never_reports_unavailable_by_variant() {
        let err = RecorderError::classify_cpal(
            "ctx",
            DevicesError::BackendSpecific { err: backend("host unavailable") },
        );
        assert_eq!(name_of(&err), "Failed");
    }

    // Regression guard for the get_optimal_config site (recorder.rs): on macOS
    // a vanished mic surfaces as a non-permission BackendSpecific from
    // supported_input_configs(), which classify_cpal alone labels Failed. The
    // call site remaps that Failed fallback to NoInputDevice; a permission
    // signal must survive the remap unchanged.
    #[test]
    fn config_query_failed_fallback_remaps_to_no_input_device() {
        let remap = |e: SupportedStreamConfigsError| match RecorderError::classify_cpal("ctx", e) {
            RecorderError::Failed { message } => RecorderError::NoInputDevice { message },
            classified => classified,
        };

        // Non-permission BackendSpecific (the macOS vanished-mic case) -> NoInputDevice.
        assert_eq!(
            name_of(&remap(SupportedStreamConfigsError::BackendSpecific {
                err: backend("An unknown error unknown to the coreaudio-rs API occurred"),
            })),
            "NoInputDevice"
        );

        // A permission denial in the description must NOT be downgraded.
        assert_eq!(
            name_of(&remap(SupportedStreamConfigsError::BackendSpecific {
                err: backend("access is denied (0x80070005)"),
            })),
            "PermissionDenied"
        );
    }

    // The context is prepended to the underlying error message.
    #[test]
    fn message_includes_context() {
        let err = RecorderError::classify_cpal(
            "Failed to build F32 stream",
            BuildStreamError::DeviceNotAvailable,
        );
        let RecorderError::NoInputDevice { message } = err else {
            panic!("expected NoInputDevice");
        };
        assert!(message.starts_with("Failed to build F32 stream: "));
    }

    // The wire shape the TypeScript side switches on: internally tagged
    // `{ name, message }`, not externally tagged `{ NoInputDevice: { .. } }`.
    #[test]
    fn serializes_as_internally_tagged_name_message() {
        let json = serde_json::to_value(RecorderError::no_input_device("no mic")).unwrap();
        assert_eq!(json["name"], "NoInputDevice");
        assert_eq!(json["message"], "no mic");

        let json = serde_json::to_value(RecorderError::failed("boom")).unwrap();
        assert_eq!(json["name"], "Failed");
        assert_eq!(json["message"], "boom");

        let json = serde_json::to_value(RecorderError::PermissionDenied {
            message: "denied".to_string(),
        })
        .unwrap();
        assert_eq!(json["name"], "PermissionDenied");
        assert_eq!(json["message"], "denied");
    }
}
