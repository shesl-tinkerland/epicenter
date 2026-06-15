use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// A logical modifier. Left and right are collapsed in v1 (ControlLeft and
/// ControlRight both become `Ctrl`); the Wayland and left/right gaps are
/// documented refusals in the spec. `Fn` is the capability the Tauri
/// global-shortcut plugin could never express.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, specta::Type,
)]
#[serde(rename_all = "lowercase")]
pub enum Modifier {
    Ctrl,
    Alt,
    Shift,
    Meta,
    Fn,
}

/// A non-modifier key, named by physical position (Wave 1 Lock: desktop binds
/// in physical-key space, not produced-character space). Variant names mirror
/// rdev's `Key` for the keys we support so the rdev mapping is near 1:1, but
/// this is our own stable enum: the persisted binding format must not depend on
/// rdev's enum names. Keys outside this set are not bindable (`rdev_map` returns
/// `None`), which keeps this a pure string union on the TypeScript side.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, specta::Type,
)]
#[serde(rename_all = "camelCase")]
pub enum Key {
    KeyA,
    KeyB,
    KeyC,
    KeyD,
    KeyE,
    KeyF,
    KeyG,
    KeyH,
    KeyI,
    KeyJ,
    KeyK,
    KeyL,
    KeyM,
    KeyN,
    KeyO,
    KeyP,
    KeyQ,
    KeyR,
    KeyS,
    KeyT,
    KeyU,
    KeyV,
    KeyW,
    KeyX,
    KeyY,
    KeyZ,
    Num0,
    Num1,
    Num2,
    Num3,
    Num4,
    Num5,
    Num6,
    Num7,
    Num8,
    Num9,
    F1,
    F2,
    F3,
    F4,
    F5,
    F6,
    F7,
    F8,
    F9,
    F10,
    F11,
    F12,
    F13,
    F14,
    F15,
    F16,
    F17,
    F18,
    F19,
    F20,
    F21,
    F22,
    F23,
    F24,
    Space,
    Return,
    Tab,
    Escape,
    Backspace,
    Delete,
    Insert,
    UpArrow,
    DownArrow,
    LeftArrow,
    RightArrow,
    Home,
    End,
    PageUp,
    PageDown,
    Minus,
    Equal,
    LeftBracket,
    RightBracket,
    SemiColon,
    Quote,
    BackQuote,
    BackSlash,
    Comma,
    Dot,
    Slash,
}

/// A desktop global binding. It fires when its modifiers and keys are held
/// exactly (see `Matcher`), matching the existing `arraysMatch` semantics of
/// `local-shortcut-manager` and the plugin's exact-modifier behavior. An empty
/// `keys` with non-empty `modifiers` is a modifier-only hold (for example hold
/// Meta), which was impossible with the plugin. The matcher also accepts a bare
/// key with no modifiers, but the frontend refuses to *configure* one (a global
/// gesture must carry a modifier or Fn so it cannot fire on an ordinary
/// keypress); the matcher stays permissive so the policy lives in one place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KeyBinding {
    pub modifiers: Vec<Modifier>,
    pub keys: Vec<Key>,
}

impl KeyBinding {
    /// A binding with neither modifiers nor keys can never become "held" and
    /// would otherwise match the all-released state. The matcher drops these.
    pub fn is_empty(&self) -> bool {
        self.modifiers.is_empty() && self.keys.is_empty()
    }

    /// Order-independent, de-duplicated view used for matching. The wire shape
    /// is a `Vec` (specta-friendly); matching is set equality.
    pub fn sets(&self) -> (BTreeSet<Modifier>, BTreeSet<Key>) {
        (
            self.modifiers.iter().copied().collect(),
            self.keys.iter().copied().collect(),
        )
    }
}
