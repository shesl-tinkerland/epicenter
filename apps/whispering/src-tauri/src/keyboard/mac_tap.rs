//! macOS keyboard tap: the `listen` primitive for the supervisor on macOS,
//! owned in-tree instead of rented from `rdev::listen`.
//!
//! Why this exists. The rustdesk fork of rdev (`src/macos/listen.rs`) attaches
//! its CGEventTap source to `CFRunLoopGetMain()` and then calls
//! `CFRunLoopRun()`, which runs the *calling* thread's run loop. Whispering
//! spawns the listener on a background thread, where that thread's run loop has
//! no sources, so `CFRunLoopRun()` returns immediately, `listen()` returns
//! `Ok(())` instantly, and the supervisor misreads "registered" as "the tap
//! died" -> five restarts -> a false `Broken`. (rdev's own `grab.rs` uses
//! `CFRunLoopGetCurrent()` and is correct; only the `listen` path is wrong.)
//!
//! This module fixes that by construction, and closes two more gaps neither
//! rdev fork covers:
//! - it adds the tap source to **this** thread's run loop (`CFRunLoop::get_current`)
//!   and blocks here, so `listen` is a real blocking call the supervisor can
//!   trust;
//! - it **re-enables** a tap that macOS silently disabled under load
//!   (`kCGEventTapDisabledByTimeout` / `…ByUserInput`);
//! - it uses the safe `core-graphics` / `core-foundation` wrappers, whose RAII
//!   releases the mach port and run-loop source on return, so restarts do not
//!   leak onto the run loop the way the raw-FFI fork does.
//!
//! It produces the same normalized `(Edge, Input)` stream the matcher already
//! consumes, so `matcher`, `keys`, and `event` are untouched. The macOS
//! virtual-keycode mapping below is the macOS analogue of `rdev_map::classify`
//! (which still serves the other platforms): keycodes are the stable Carbon
//! `kVK_*` values, transcribed from rdev's own table.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use core_foundation::base::TCFType;
use core_foundation::mach_port::CFMachPortRef;
use core_foundation::runloop::{kCFRunLoopCommonModes, kCFRunLoopDefaultMode, CFRunLoop};
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType, EventField,
};

use super::keys::{Key, Modifier};
use super::matcher::{Edge, Input};

// `core-graphics` 0.22 wraps `CGEventTapEnable` only as a method on the tap it
// owns; we re-enable from the supervisor loop (which holds the port directly),
// so declare the two raw entry points. They live in the CoreGraphics framework
// that the `core-graphics` crate already links, so no `#[link]` is needed.
extern "C" {
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventTapIsEnabled(tap: CFMachPortRef) -> bool;
}

/// Why the tap could not be created. The supervisor only needs the debug string
/// for its log; it decides restart-vs-untrusted from a fresh `AXIsProcessTrusted`
/// probe, not from this.
#[derive(Debug)]
pub enum TapError {
    /// `CGEventTapCreate` returned null. In practice: Accessibility trust was
    /// lost between the supervisor's gate check and this call.
    Create,
    /// The tap was created but its run-loop source could not be built.
    Source,
}

/// Set when the supervisor wants the active tap to stop; checked each run-loop
/// slice. The supervisor serializes spawns (exactly one tap thread at a time),
/// so a single process-wide flag plus loop ref is sufficient.
static STOP: AtomicBool = AtomicBool::new(false);

/// The run loop of the live tap thread, so `stop` can wake it from another
/// thread (`CFRunLoop` is `Send`/`Sync`). `None` whenever no tap is running.
static ACTIVE_LOOP: Mutex<Option<CFRunLoop>> = Mutex::new(None);

/// Run a passive system-wide keyboard tap on the calling thread, delivering one
/// normalized `(Edge, Input)` per key transition to `callback`, and block until
/// the tap is stopped (`stop`) or fails. Returns `Ok(())` on a clean stop and
/// `Err(TapError)` if the tap could not be created — the same blocking contract
/// the supervisor expects from `rdev::listen`, but actually honored.
pub fn listen<F: Fn(Edge, Input)>(callback: F) -> Result<(), TapError> {
    STOP.store(false, Ordering::SeqCst);

    // `ListenOnly` is load-bearing: a passive listener observes events and
    // cannot swallow them, so keystrokes still reach the foreground app (this is
    // `listen`, not `grab`). Modifier-only chords and the Fn key arrive as
    // `FlagsChanged`, not `KeyDown`, so that type is in the mask.
    let tap = CGEventTap::new(
        CGEventTapLocation::Session,
        CGEventTapPlacement::HeadInsertEventTap,
        CGEventTapOptions::ListenOnly,
        vec![
            CGEventType::KeyDown,
            CGEventType::KeyUp,
            CGEventType::FlagsChanged,
        ],
        move |_proxy, event_type, event| {
            if let Some((edge, input)) = decode(event_type, event) {
                callback(edge, input);
            }
            // ListenOnly ignores the return value; `None` passes the event on.
            None
        },
    )
    .map_err(|()| TapError::Create)?;

    let source = tap
        .mach_port
        .create_runloop_source(0)
        .map_err(|()| TapError::Source)?;

    let run_loop = CFRunLoop::get_current();
    // SAFETY: `kCFRunLoop*Mode` are framework string constants, valid for the
    // process lifetime. The source is added to CommonModes so it stays active
    // across modes; the loop is then driven in DefaultMode below.
    let common_modes = unsafe { kCFRunLoopCommonModes };
    let default_mode = unsafe { kCFRunLoopDefaultMode };
    run_loop.add_source(&source, common_modes);
    tap.enable();

    if let Ok(mut active) = ACTIVE_LOOP.lock() {
        *active = Some(run_loop.clone());
    }

    let port = tap.mach_port.as_concrete_TypeRef();
    while !STOP.load(Ordering::SeqCst) {
        // Re-enable a tap macOS disabled under load. Neither rdev fork does
        // this, so a tap timed out once would otherwise stay dead until the next
        // full restart. SAFETY: `port` is the live mach port owned by `tap`,
        // valid for this whole scope.
        unsafe {
            if !CGEventTapIsEnabled(port) {
                CGEventTapEnable(port, true);
            }
        }
        // Bounded slices, not one blocking `run`, so the stop flag and the
        // re-enable probe each get a turn. Events are still delivered the instant
        // they arrive within a slice, so this adds no input latency.
        CFRunLoop::run_in_mode(default_mode, Duration::from_millis(250), false);
    }

    if let Ok(mut active) = ACTIVE_LOOP.lock() {
        *active = None;
    }
    // `tap` and `source` drop here: their RAII wrappers `CFRelease` the mach port
    // and the run-loop source, so a restart starts clean.
    Ok(())
}

/// Ask the live tap (if any) to stop and return from `listen`. Safe to call from
/// any thread and when nothing is running. Called by the supervisor's
/// `request_tap_stop` when the last tap-needing binding leaves.
pub fn stop() {
    STOP.store(true, Ordering::SeqCst);
    if let Ok(active) = ACTIVE_LOOP.lock() {
        if let Some(run_loop) = active.as_ref() {
            run_loop.stop();
        }
    }
}

/// Classify one Quartz event into the matcher's vocabulary, or `None` for events
/// we do not bind. This is the macOS counterpart of `rdev_map::classify`.
fn decode(event_type: CGEventType, event: &CGEvent) -> Option<(Edge, Input)> {
    let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as u16;
    match event_type {
        // Auto-repeat re-sends `KeyDown` while a key is held; collapse it to a
        // single press so a held key is one transition (like the modifier path)
        // and bindings cannot re-fire on repeat.
        CGEventType::KeyDown => {
            if event.get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT) != 0 {
                return None;
            }
            Some((Edge::Press, Input::Key(key_from_keycode(keycode)?)))
        }
        CGEventType::KeyUp => Some((Edge::Release, Input::Key(key_from_keycode(keycode)?))),
        // Modifiers (incl. Fn) have no KeyUp; they arrive as FlagsChanged. The
        // keycode says which modifier moved; the flag bit says whether it is now
        // down. Because our `Modifier` collapses left/right, reading the bit
        // directly is correct and robust: with two of the same modifier held,
        // the shared bit stays set until the last release, so the logical
        // modifier stays pressed exactly as long as either physical key is.
        CGEventType::FlagsChanged => {
            let (modifier, flag) = modifier_from_keycode(keycode)?;
            let edge = if event.get_flags().contains(flag) {
                Edge::Press
            } else {
                Edge::Release
            };
            Some((edge, Input::Modifier(modifier)))
        }
        _ => None,
    }
}

/// Map a modifier virtual keycode to our logical modifier and the device-flag
/// bit that reports whether it is held. Left/right collapse, matching `rdev_map`.
/// Caps Lock (57) is a toggle, not a hold, and is not a bindable modifier here.
fn modifier_from_keycode(keycode: u16) -> Option<(Modifier, CGEventFlags)> {
    match keycode {
        56 | 60 => Some((Modifier::Shift, CGEventFlags::CGEventFlagShift)), // Shift / RightShift
        59 | 62 => Some((Modifier::Ctrl, CGEventFlags::CGEventFlagControl)), // Control / RightControl
        58 | 61 => Some((Modifier::Alt, CGEventFlags::CGEventFlagAlternate)), // Option / RightOption
        55 | 54 => Some((Modifier::Meta, CGEventFlags::CGEventFlagCommand)), // Command / RightCommand
        63 => Some((Modifier::Fn, CGEventFlags::CGEventFlagSecondaryFn)),    // Fn / Globe
        _ => None,
    }
}

/// Map a macOS virtual keycode to our physical `Key`, or `None` for keys we do
/// not bind. Keycodes are the stable Carbon `kVK_*` values (rdev's macOS table);
/// keys absent from our `Key` enum (keypad, ISO/JIS extras, F21-F24, which have
/// no macOS keycode) return `None`.
fn key_from_keycode(keycode: u16) -> Option<Key> {
    let key = match keycode {
        // Letters (kVK_ANSI_*)
        0 => Key::KeyA,
        1 => Key::KeyS,
        2 => Key::KeyD,
        3 => Key::KeyF,
        4 => Key::KeyH,
        5 => Key::KeyG,
        6 => Key::KeyZ,
        7 => Key::KeyX,
        8 => Key::KeyC,
        9 => Key::KeyV,
        11 => Key::KeyB,
        12 => Key::KeyQ,
        13 => Key::KeyW,
        14 => Key::KeyE,
        15 => Key::KeyR,
        16 => Key::KeyY,
        17 => Key::KeyT,
        31 => Key::KeyO,
        32 => Key::KeyU,
        34 => Key::KeyI,
        35 => Key::KeyP,
        37 => Key::KeyL,
        38 => Key::KeyJ,
        40 => Key::KeyK,
        45 => Key::KeyN,
        46 => Key::KeyM,
        // Number row
        18 => Key::Num1,
        19 => Key::Num2,
        20 => Key::Num3,
        21 => Key::Num4,
        22 => Key::Num6,
        23 => Key::Num5,
        25 => Key::Num9,
        26 => Key::Num7,
        28 => Key::Num8,
        29 => Key::Num0,
        // Punctuation
        24 => Key::Equal,
        27 => Key::Minus,
        30 => Key::RightBracket,
        33 => Key::LeftBracket,
        39 => Key::Quote,
        41 => Key::SemiColon,
        42 => Key::BackSlash,
        43 => Key::Comma,
        44 => Key::Slash,
        47 => Key::Dot,
        50 => Key::BackQuote,
        // Editing / whitespace
        36 => Key::Return,
        48 => Key::Tab,
        49 => Key::Space,
        51 => Key::Backspace, // kVK_Delete is the Backspace key
        53 => Key::Escape,
        114 => Key::Insert, // kVK_Help
        115 => Key::Home,
        116 => Key::PageUp,
        117 => Key::Delete, // kVK_ForwardDelete
        119 => Key::End,
        121 => Key::PageDown,
        // Arrows
        123 => Key::LeftArrow,
        124 => Key::RightArrow,
        125 => Key::DownArrow,
        126 => Key::UpArrow,
        // Function row (macOS has no keycodes for F21-F24)
        122 => Key::F1,
        120 => Key::F2,
        99 => Key::F3,
        118 => Key::F4,
        96 => Key::F5,
        97 => Key::F6,
        98 => Key::F7,
        100 => Key::F8,
        101 => Key::F9,
        109 => Key::F10,
        103 => Key::F11,
        111 => Key::F12,
        105 => Key::F13,
        107 => Key::F14,
        113 => Key::F15,
        106 => Key::F16,
        64 => Key::F17,
        79 => Key::F18,
        80 => Key::F19,
        90 => Key::F20,
        _ => return None,
    };
    Some(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_letters_numbers_and_specials() {
        assert_eq!(key_from_keycode(0), Some(Key::KeyA));
        assert_eq!(key_from_keycode(29), Some(Key::Num0));
        assert_eq!(key_from_keycode(49), Some(Key::Space));
        assert_eq!(key_from_keycode(51), Some(Key::Backspace));
        assert_eq!(key_from_keycode(117), Some(Key::Delete));
    }

    #[test]
    fn unbound_keycodes_are_none() {
        // Keypad 0 (kVK_ANSI_Keypad0 = 82) is not in our `Key` enum.
        assert_eq!(key_from_keycode(82), None);
        // kVK_Unknown.
        assert_eq!(key_from_keycode(0xFFFF), None);
    }

    #[test]
    fn fn_and_collapsed_modifiers_map_to_the_right_flag() {
        assert_eq!(
            modifier_from_keycode(63),
            Some((Modifier::Fn, CGEventFlags::CGEventFlagSecondaryFn))
        );
        // Left and right Shift collapse to the same logical modifier + flag bit.
        assert_eq!(modifier_from_keycode(56), modifier_from_keycode(60));
        // Caps Lock is a toggle, not a bindable hold.
        assert_eq!(modifier_from_keycode(57), None);
    }
}
