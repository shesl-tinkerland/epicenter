use std::collections::BTreeSet;

use super::event::{ShortcutTriggerEvent, TriggerState};
use super::keys::{Key, KeyBinding, Modifier};

/// Edge of a single key event fed in from the rdev listener.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Press,
    Release,
}

/// One normalized key, classified as a modifier or a regular key by the rdev
/// mapping layer (`rdev_map`) before it reaches the matcher. The matcher never
/// sees an `rdev::Key`, which is what keeps it pure and unit-testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    Modifier(Modifier),
    Key(Key),
}

/// One registered binding. Order-independent sets are precomputed so matching is
/// a set comparison, not a `Vec` scan.
struct Registered {
    command_id: String,
    modifiers: BTreeSet<Modifier>,
    keys: BTreeSet<Key>,
}

/// Turns the rdev event stream into `{ command_id, state }` transitions.
///
/// Matching is exact set equality: a binding fires the instant the held
/// modifiers equal its modifiers and the held keys equal its keys. There is no
/// pending window and no prefix resolution, so a gesture fires with zero latency
/// (push-to-talk starts capturing audio on the very first edge).
///
/// The cost of dropping prefix resolution is that bindings must not overlap: if
/// one binding's keys are a subset of another's (for example `Fn` and
/// `Fn` + `Space`), the shorter one fires first and the longer one can never be
/// reached, because once the shorter binding is `Active` it owns the gesture and
/// ignores the extra key. The frontend enforces this by refusing to save a
/// gesture that contains, or is contained by, another configured gesture, and
/// the shipped defaults are deliberately disjoint. That is why push-to-talk is a
/// dedicated key (`Fn`): nothing else may use it.
///
/// - A binding held exactly fires immediately (`Pressed`) and becomes `Active`.
/// - An `Active` binding owns the gesture: pressing extra keys does not release
///   it or convert it. It releases (exactly once) when one of its own keys goes
///   up.
pub struct Matcher {
    bindings: Vec<Registered>,
    held_modifiers: BTreeSet<Modifier>,
    held_keys: BTreeSet<Key>,
    /// Index of the binding that currently owns the gesture, or `None` when idle.
    /// The desktop backend resolves **one** gesture at a time: a global
    /// push-to-talk hold owns the keyboard until it releases, so we never track
    /// two bindings as simultaneously held (that is what lets a resolved
    /// push-to-talk ignore extra keys instead of converting into a chord). It
    /// stays active (extra keys ignored) until one of its own keys releases.
    active: Option<usize>,
    capturing: bool,
}

impl Matcher {
    pub fn new() -> Self {
        Self {
            bindings: Vec::new(),
            held_modifiers: BTreeSet::new(),
            held_keys: BTreeSet::new(),
            active: None,
            capturing: false,
        }
    }

    /// Enter or leave capture mode. While capturing, `on_event` updates the held
    /// set but emits no triggers; the listener reads `held_binding` instead and
    /// forwards it to the settings recorder. The in-flight gesture is reset so
    /// nothing is left half-fired across the mode switch.
    pub fn set_capturing(&mut self, capturing: bool) {
        self.capturing = capturing;
        self.active = None;
    }

    pub fn is_capturing(&self) -> bool {
        self.capturing
    }

    /// The currently-held keys as a binding, for the recorder to accumulate.
    pub fn held_binding(&self) -> KeyBinding {
        KeyBinding {
            modifiers: self.held_modifiers.iter().copied().collect(),
            keys: self.held_keys.iter().copied().collect(),
        }
    }

    /// Drop all held state and the in-flight gesture. Called when the listener
    /// (re)enters `rdev::listen`: a prior attempt that exited may have missed a
    /// key-up, and a stale held modifier would otherwise wedge a binding "down"
    /// or suppress the next press.
    pub fn clear_held(&mut self) {
        self.held_modifiers.clear();
        self.held_keys.clear();
        self.active = None;
    }

    /// Replace the full set of registered bindings. Empty bindings are dropped
    /// (they can never be "held"). The held sets are left untouched: the physical
    /// keys really are still down.
    ///
    /// Any in-flight gesture resets to idle (its index points into the old vec,
    /// so it cannot survive the swap anyway). The FE only re-pushes between
    /// sessions, on launch, on a settings edit, or on reset, never while a global
    /// gesture is physically held, so there is no resolved gesture to carry across.
    ///
    /// Precondition: the bindings must be pairwise non-overlapping (no key set a
    /// subset of another's). This matcher assumes it but does not enforce it; the
    /// invariant is owned by the FE recorder (`bindingsOverlap` in
    /// `key-binding.ts`), which refuses to save an overlapping gesture, and by the
    /// disjoint shipped defaults. If a binding ever overlaps anyway (a hand-edited
    /// settings file, a future migration), the consequence is benign and
    /// deterministic, not a panic: the shorter binding fires first and shadows the
    /// longer, which can never be reached. See the
    /// `an_overlapping_longer_binding_is_unreachable` test for that behavior.
    pub fn set_bindings(&mut self, bindings: impl IntoIterator<Item = (String, KeyBinding)>) {
        self.bindings = bindings
            .into_iter()
            .filter(|(_, binding)| !binding.is_empty())
            .map(|(command_id, binding)| {
                let (modifiers, keys) = binding.sets();
                Registered {
                    command_id,
                    modifiers,
                    keys,
                }
            })
            .collect();
        self.active = None;
    }

    /// Feed one key event. Updates the held sets, then resolves the gesture and
    /// returns the transitions to emit (empty when nothing changes).
    pub fn on_event(&mut self, edge: Edge, input: Input) -> Vec<ShortcutTriggerEvent> {
        // Apply the edge. `changed` is false for an auto-repeat press (the key is
        // already held) or a stray release of an absent key. Those are no-ops:
        // returning early keeps auto-repeat from re-firing a binding.
        let changed = match (edge, input) {
            (Edge::Press, Input::Modifier(m)) => self.held_modifiers.insert(m),
            (Edge::Release, Input::Modifier(m)) => self.held_modifiers.remove(&m),
            (Edge::Press, Input::Key(k)) => self.held_keys.insert(k),
            (Edge::Release, Input::Key(k)) => self.held_keys.remove(&k),
        };
        if !changed {
            return Vec::new();
        }

        // In capture mode the listener forwards `held_binding()` to the recorder;
        // it does not match registered bindings.
        if self.capturing {
            return Vec::new();
        }

        match self.active {
            // An active binding owns the gesture. Extra presses are ignored; it
            // releases only when one of its own keys/modifiers goes up (so the
            // held set is no longer a superset of the binding).
            Some(index) => {
                if self.held_is_superset_of(index) {
                    Vec::new()
                } else {
                    self.active = None;
                    vec![self.release(index)]
                }
            }
            // Nothing in flight. A press that exactly matches a binding fires it;
            // a partial chord (or any release) waits silently.
            None => {
                if edge == Edge::Press {
                    if let Some(index) = self.find_exact() {
                        self.active = Some(index);
                        return vec![self.press(index)];
                    }
                }
                Vec::new()
            }
        }
    }

    /// First binding whose modifier and key sets equal the held sets exactly.
    /// First-wins makes a duplicate binding (two commands on the same combo)
    /// resolve deterministically to the one registered earlier, and fires a
    /// single command rather than both.
    fn find_exact(&self) -> Option<usize> {
        self.bindings
            .iter()
            .position(|b| b.modifiers == self.held_modifiers && b.keys == self.held_keys)
    }

    /// Whether the held set still contains all of `index`'s modifiers and keys
    /// (extra held keys allowed). This is the "still held" test for an active
    /// binding: it tolerates extra keys so a resolved gesture is not broken by
    /// later presses.
    fn held_is_superset_of(&self, index: usize) -> bool {
        let b = &self.bindings[index];
        b.modifiers.is_subset(&self.held_modifiers) && b.keys.is_subset(&self.held_keys)
    }

    fn press(&self, index: usize) -> ShortcutTriggerEvent {
        ShortcutTriggerEvent {
            command_id: self.bindings[index].command_id.clone(),
            state: TriggerState::Pressed,
        }
    }

    fn release(&self, index: usize) -> ShortcutTriggerEvent {
        ShortcutTriggerEvent {
            command_id: self.bindings[index].command_id.clone(),
            state: TriggerState::Released,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(modifiers: &[Modifier], keys: &[Key]) -> KeyBinding {
        KeyBinding {
            modifiers: modifiers.to_vec(),
            keys: keys.to_vec(),
        }
    }

    /// Drive a sequence of events through the matcher and collect every emitted
    /// transition as `(command_id, state)` pairs.
    fn run(matcher: &mut Matcher, events: &[(Edge, Input)]) -> Vec<(String, TriggerState)> {
        let mut out = Vec::new();
        for &(edge, input) in events {
            for ev in matcher.on_event(edge, input) {
                out.push((ev.command_id, ev.state));
            }
        }
        out
    }

    use Edge::{Press, Release};
    use Input::Key as K;
    use Input::Modifier as M;
    use Modifier::{Fn, Meta, Shift};
    use TriggerState::{Pressed, Released};

    #[test]
    fn chord_fires_once_when_the_last_key_completes_it_and_releases_when_it_breaks() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([(
            "pushToTalk".to_string(),
            binding(&[Meta, Shift], &[Key::KeyD]),
        )]);

        // Modifiers alone do not satisfy the chord; only the final key does, and
        // it fires immediately on the D press (no window).
        let events = run(
            &mut matcher,
            &[
                (Press, M(Meta)),
                (Press, M(Shift)),
                (Press, K(Key::KeyD)),
                (Release, K(Key::KeyD)),
                (Release, M(Shift)),
                (Release, M(Meta)),
            ],
        );
        assert_eq!(
            events,
            vec![
                ("pushToTalk".to_string(), Pressed),
                ("pushToTalk".to_string(), Released),
            ]
        );
    }

    #[test]
    fn clear_held_drops_stale_state_so_a_missed_release_cannot_wedge_a_binding() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("ptt".to_string(), binding(&[], &[Key::Space]))]);

        // Space goes down (binding fires), then the key-up is "missed" (the
        // listener exited mid-hold). clear_held models the listener restart.
        let pressed = run(&mut matcher, &[(Press, K(Key::Space))]);
        assert_eq!(pressed, vec![("ptt".to_string(), Pressed)]);
        matcher.clear_held();

        // A later stray release must not emit, and a fresh press still works.
        let after = run(
            &mut matcher,
            &[(Release, K(Key::Space)), (Press, K(Key::Space))],
        );
        assert_eq!(after, vec![("ptt".to_string(), Pressed)]);
    }

    #[test]
    fn modifier_order_does_not_matter() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("x".to_string(), binding(&[Meta, Shift], &[Key::KeyD]))]);
        // Shift before Meta still completes on KeyD.
        let events = run(
            &mut matcher,
            &[(Press, M(Shift)), (Press, M(Meta)), (Press, K(Key::KeyD))],
        );
        assert_eq!(events, vec![("x".to_string(), Pressed)]);
    }

    #[test]
    fn modifier_only_binding_presses_and_releases_on_the_modifier_alone() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("toggle".to_string(), binding(&[Meta], &[]))]);
        let events = run(&mut matcher, &[(Press, M(Meta)), (Release, M(Meta))]);
        assert_eq!(
            events,
            vec![
                ("toggle".to_string(), Pressed),
                ("toggle".to_string(), Released),
            ]
        );
    }

    #[test]
    fn single_key_push_to_talk_with_no_modifiers() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("ptt".to_string(), binding(&[], &[Key::Space]))]);
        let events = run(
            &mut matcher,
            &[(Press, K(Key::Space)), (Release, K(Key::Space))],
        );
        assert_eq!(
            events,
            vec![("ptt".to_string(), Pressed), ("ptt".to_string(), Released)]
        );
    }

    #[test]
    fn fn_modifier_binding_fires_immediately() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("ptt".to_string(), binding(&[Fn], &[]))]);
        let events = run(&mut matcher, &[(Press, M(Fn)), (Release, M(Fn))]);
        assert_eq!(
            events,
            vec![("ptt".to_string(), Pressed), ("ptt".to_string(), Released)]
        );
    }

    #[test]
    fn capture_mode_emits_no_triggers_and_held_binding_reflects_the_combo() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("ptt".to_string(), binding(&[], &[Key::Space]))]);
        matcher.set_capturing(true);

        // A registered binding must not fire while capturing.
        let events = run(&mut matcher, &[(Press, M(Fn)), (Press, K(Key::KeyD))]);
        assert!(events.is_empty());

        // The held combo is what the recorder reads and commits (Fn + D, the
        // kind of binding the webview could never capture).
        let held = matcher.held_binding();
        assert_eq!(held.modifiers, vec![Fn]);
        assert_eq!(held.keys, vec![Key::KeyD]);

        // Leaving capture mode re-arms normal matching.
        matcher.set_capturing(false);
        let after = run(&mut matcher, &[(Release, M(Fn))]);
        assert!(after.is_empty());
    }

    #[test]
    fn auto_repeat_does_not_re_emit_pressed() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("ptt".to_string(), binding(&[], &[Key::KeyD]))]);
        // A held key auto-repeats: rdev delivers KeyPress(KeyD) again. The
        // second and third press must not produce a second Pressed.
        let events = run(
            &mut matcher,
            &[
                (Press, K(Key::KeyD)),
                (Press, K(Key::KeyD)),
                (Press, K(Key::KeyD)),
                (Release, K(Key::KeyD)),
            ],
        );
        assert_eq!(
            events,
            vec![("ptt".to_string(), Pressed), ("ptt".to_string(), Released)]
        );
    }

    #[test]
    fn empty_bindings_are_dropped_and_never_fire() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("noop".to_string(), binding(&[], &[]))]);
        // The all-released state must not be reported as a press for an empty
        // binding. Feeding an unrelated key produces nothing.
        let events = run(
            &mut matcher,
            &[(Press, K(Key::KeyA)), (Release, K(Key::KeyA))],
        );
        assert!(events.is_empty());
    }

    #[test]
    fn two_bindings_track_independently() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([
            ("a".to_string(), binding(&[Meta], &[Key::KeyA])),
            ("b".to_string(), binding(&[Meta], &[Key::KeyB])),
        ]);
        let events = run(
            &mut matcher,
            &[
                (Press, M(Meta)),
                (Press, K(Key::KeyA)),   // a fires
                (Release, K(Key::KeyA)), // a releases
                (Press, K(Key::KeyB)),   // b fires
                (Release, K(Key::KeyB)), // b releases
            ],
        );
        assert_eq!(
            events,
            vec![
                ("a".to_string(), Pressed),
                ("a".to_string(), Released),
                ("b".to_string(), Pressed),
                ("b".to_string(), Released),
            ]
        );
    }

    #[test]
    fn an_active_gesture_ignores_extra_keys_and_releases_once() {
        // Push-to-talk on Fn, plus a disjoint toggle. While Fn is active, pressing
        // Space (which alone matches nothing here) is ignored, and Fn up releases
        // push-to-talk exactly once. This is the invariant the no-overlap policy
        // relies on: one gesture owns the keyboard until its own key lifts.
        let mut matcher = Matcher::new();
        matcher.set_bindings([("ptt".to_string(), binding(&[Fn], &[]))]);

        let events = run(
            &mut matcher,
            &[
                (Press, M(Fn)),          // ptt fires immediately
                (Press, K(Key::Space)),  // extra key: ignored
                (Release, K(Key::Space)),
                (Release, M(Fn)),        // ptt releases
            ],
        );
        assert_eq!(
            events,
            vec![("ptt".to_string(), Pressed), ("ptt".to_string(), Released)]
        );
    }

    #[test]
    fn an_overlapping_longer_binding_is_unreachable() {
        // Documents the cost of dropping prefix resolution: when one binding is a
        // subset of another (Fn vs Fn+Space), the shorter fires first and owns the
        // gesture, so the longer one never fires. The FE refuses to save such a
        // pair; this proves why.
        let mut matcher = Matcher::new();
        matcher.set_bindings([
            ("ptt".to_string(), binding(&[Fn], &[])),
            ("toggle".to_string(), binding(&[Fn], &[Key::Space])),
        ]);

        let events = run(
            &mut matcher,
            &[
                (Press, M(Fn)),         // ptt fires; Fn is held exactly
                (Press, K(Key::Space)), // would complete toggle, but ptt owns it
                (Release, K(Key::Space)),
                (Release, M(Fn)),
            ],
        );
        assert_eq!(
            events,
            vec![("ptt".to_string(), Pressed), ("ptt".to_string(), Released)]
        );
    }

    #[test]
    fn re_pushing_bindings_resets_any_in_flight_gesture() {
        // The FE re-pushes the full set only between sessions, never while a
        // gesture is physically held, so a swap always restarts resolution from
        // Idle. A key still down when the swap lands does not emit on release:
        // the gesture that owned it is gone (even when the binding itself stays).
        let mut matcher = Matcher::new();
        matcher.set_bindings([("a".to_string(), binding(&[], &[Key::Space]))]);
        let first = run(&mut matcher, &[(Press, K(Key::Space))]);
        assert_eq!(first, vec![("a".to_string(), Pressed)]);

        matcher.set_bindings([("a".to_string(), binding(&[], &[Key::Space]))]);
        let after = run(&mut matcher, &[(Release, K(Key::Space))]);
        assert!(after.is_empty());
    }

    #[test]
    fn duplicate_bindings_on_the_same_combo_fire_only_the_first_registered() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([
            ("first".to_string(), binding(&[Meta], &[Key::KeyD])),
            ("second".to_string(), binding(&[Meta], &[Key::KeyD])),
        ]);
        let events = run(
            &mut matcher,
            &[(Press, M(Meta)), (Press, K(Key::KeyD))],
        );
        assert_eq!(events, vec![("first".to_string(), Pressed)]);
    }
}
