//! The tap supervisor's decision core, separated from its effects so it can be
//! table-tested without a real keyboard, clock, or OS trust query.
//!
//! [`Supervisor::step`] is pure: given what woke it (`Some(Control)` or `None`
//! for a timeout tick), the current trust, and a monotonic millisecond clock, it
//! mutates its own state and returns an [`Outcome`]: at most one [`Effect`] to
//! run (spawn or stop the tap), the [`DictationCapability`] to publish, and how
//! long to wait for the next signal. The owning loop in `mod.rs` performs the
//! I/O (channel receive, `AXIsProcessTrusted`, thread spawn, event emit); this
//! module decides, so the part that used to be hardest to trust is now the part
//! under test.
//!
//! The wait time unifies what used to be two separate mechanisms. A bounded
//! grant poll and a tap-restart backoff are both just "wake me after this
//! `Duration`," so the supervisor never blocks on `thread::sleep`: an intent
//! change always interrupts a pending backoff because the loop is sitting in
//! `recv_timeout`, not asleep.

use std::time::Duration;

use super::event::DictationCapability;

/// Backoff for a tap that dies while the grant still holds, so a genuinely broken
/// tap cannot hot-loop. After the last step the supervisor gives up to `Broken`.
/// A death more than `RESET_WINDOW_MS` after the previous one starts with a fresh
/// budget, because there is no positive "stayed alive" signal to reset on.
const RESTART_BACKOFF_MS: [u64; 5] = [1_000, 2_000, 4_000, 8_000, 16_000];
const RESET_WINDOW_MS: u64 = 60_000;

/// How long the supervisor waits between `AXIsProcessTrusted` re-checks while it
/// wants the tap but cannot run it. macOS fires no event when Accessibility
/// flips, so this bounded poll is the one unavoidable re-check; it runs only
/// while waiting for the grant, never as a steady-state timer once the tap runs.
const TRUST_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// A message on the supervisor's control channel. `None` passed to
/// [`Supervisor::step`] (rather than a `Control`) means the wait elapsed: a grant
/// poll tick or an elapsed restart backoff, told apart by the supervisor's own
/// state.
pub(crate) enum Control {
    /// The tap thread exited. The debug reason is logged where the thread dies,
    /// so the supervisor needs no payload: it decides what the exit means from
    /// trust and intent.
    TapStopped,
    /// Whether any Fn / modifier-only binding is bound (`true` = the tap is needed
    /// to read it; chords go to the plugin instead).
    Bindings(bool),
    /// Whether auto-paste-at-cursor is enabled. It writes a synthetic Cmd/Ctrl+V
    /// through the same grant the tap reads through, so when it is on the tap is
    /// held even with no binding: the tap's liveness is how a stale grant (which
    /// reads as trusted but kills the tap) is caught for paste too.
    AutoPaste(bool),
    /// Whether the settings recorder is capturing a binding. Capture needs the tap
    /// running to read Fn and physical keys, so it holds the tap for its duration
    /// even with nothing bound: this is what lets the first Fn binding be recorded
    /// from the dormant floor.
    Capturing(bool),
}

/// The reasons the tap may be held, all of which mean the same thing to the tap:
/// something wants the macOS Accessibility grant. The supervisor never acts on
/// *which* reason, only on whether any holds, so the disjunction lives in one
/// place ([`TapIntent::wants_tap`]).
#[derive(Default)]
struct TapIntent {
    bindings: bool,
    auto_paste: bool,
    capturing: bool,
}

impl TapIntent {
    fn wants_tap(&self) -> bool {
        self.bindings || self.auto_paste || self.capturing
    }
}

/// A side effect for the owning loop to perform. At most one per step: a single
/// signal never both spawns and stops the tap.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Effect {
    SpawnTap,
    StopTap,
}

/// What one step decided: the effect to run (if any), the capability to publish,
/// and how long to wait for the next signal (`None` = block until a `Control`
/// arrives).
pub(crate) struct Outcome {
    pub effect: Option<Effect>,
    pub phase: DictationCapability,
    pub next_timeout: Option<Duration>,
}

/// The tap lifecycle decision state. Holds everything the next decision needs:
/// what wants the tap, whether one is believed alive, and the restart budget.
pub(crate) struct Supervisor {
    intent: TapIntent,
    /// Whether a tap thread is believed alive. Flipped true when we emit
    /// `SpawnTap`, and false only when a `TapStopped` confirms the death, so we
    /// never spawn a second tap over a live one.
    tap_running: bool,
    restart_attempt: usize,
    /// Monotonic ms of the last tap death, for the reset-window check.
    last_stop: Option<u64>,
    /// Set while a backoff restart is pending: doubles as "the next timeout is a
    /// restart, not a poll" and the delay to wait. Cleared when the restart fires
    /// or a fresh intent cancels it.
    restart_delay: Option<Duration>,
    phase: DictationCapability,
}

impl Supervisor {
    pub(crate) fn new() -> Self {
        Self {
            intent: TapIntent::default(),
            tap_running: false,
            restart_attempt: 0,
            last_stop: None,
            restart_delay: None,
            phase: DictationCapability::Inactive,
        }
    }

    /// Advance one step. `control` is `Some` for a channel message and `None` for
    /// an elapsed wait; `trusted` is a fresh `AXIsProcessTrusted` sample; `now_ms`
    /// is a monotonic millisecond clock (only the delta matters).
    pub(crate) fn step(&mut self, control: Option<Control>, trusted: bool, now_ms: u64) -> Outcome {
        let effect = match control {
            None => self.on_timeout(trusted),
            Some(Control::Bindings(next)) => {
                self.intent.bindings = next;
                self.reconcile(trusted)
            }
            Some(Control::AutoPaste(next)) => {
                self.intent.auto_paste = next;
                self.reconcile(trusted)
            }
            Some(Control::Capturing(next)) => {
                self.intent.capturing = next;
                self.reconcile(trusted)
            }
            Some(Control::TapStopped) => self.on_tap_stopped(trusted, now_ms),
        };
        Outcome {
            effect,
            phase: self.phase,
            next_timeout: self.next_timeout(),
        }
    }

    /// A wait elapsed. Either a scheduled backoff restart (we hold a
    /// `restart_delay`) or a grant poll while `Untrusted` / `Broken`.
    fn on_timeout(&mut self, trusted: bool) -> Option<Effect> {
        if self.restart_delay.take().is_some() {
            // Backoff elapsed: respawn. Phase stayed `Active` across the wait, so
            // a transient restart never flaps the UI.
            self.tap_running = true;
            return Some(Effect::SpawnTap);
        }
        if trusted {
            // `Untrusted` -> the grant returned, so start. `Broken` -> keep
            // watching for the remove (a trust drop) that precedes a re-add; a
            // still-trusted stale grant must not respawn, or the tap just dies again.
            if self.phase == DictationCapability::Untrusted {
                self.tap_running = true;
                self.restart_attempt = 0;
                self.phase = DictationCapability::Active;
                return Some(Effect::SpawnTap);
            }
            None
        } else {
            self.restart_attempt = 0;
            self.phase = DictationCapability::Untrusted;
            None
        }
    }

    /// Intent changed. A fresh intent cancels any pending backoff and resets the
    /// restart budget, then the tap is reconciled to whether anything still wants
    /// the grant.
    fn reconcile(&mut self, trusted: bool) -> Option<Effect> {
        self.restart_attempt = 0;
        self.restart_delay = None;
        if !self.intent.wants_tap() {
            // Nothing needs the grant. Ask a live tap to stop (the `TapStopped`
            // that follows flips `tap_running`); publish `Inactive` now so the
            // floor shows nothing.
            self.phase = DictationCapability::Inactive;
            self.tap_running.then_some(Effect::StopTap)
        } else if !trusted {
            self.phase = DictationCapability::Untrusted;
            None
        } else {
            self.phase = DictationCapability::Active;
            if self.tap_running {
                None
            } else {
                self.tap_running = true;
                Some(Effect::SpawnTap)
            }
        }
    }

    /// The tap exited.
    fn on_tap_stopped(&mut self, trusted: bool, now_ms: u64) -> Option<Effect> {
        self.tap_running = false;
        if !self.intent.wants_tap() {
            // We asked it to stop because the last reason left. Settled.
            self.phase = DictationCapability::Inactive;
        } else if !trusted {
            // The grant vanished; the next grant respawns.
            self.restart_attempt = 0;
            self.phase = DictationCapability::Untrusted;
        } else {
            // Trusted and still wanted, but the tap died: schedule a capped
            // backoff restart, then settle on `Broken` once the budget is spent.
            if self
                .last_stop
                .is_some_and(|t| now_ms.saturating_sub(t) > RESET_WINDOW_MS)
            {
                self.restart_attempt = 0;
            }
            self.last_stop = Some(now_ms);
            if self.restart_attempt >= RESTART_BACKOFF_MS.len() {
                self.phase = DictationCapability::Broken;
            } else {
                let delay = RESTART_BACKOFF_MS[self.restart_attempt];
                self.restart_attempt += 1;
                self.restart_delay = Some(Duration::from_millis(delay));
                // Stay `Active` across the wait: no user-facing flap. The spawn
                // happens when the backoff timeout fires.
                self.phase = DictationCapability::Active;
            }
        }
        None
    }

    /// How long to wait for the next signal: a pending backoff, else a grant poll
    /// while waiting for the grant, else block until a `Control` arrives.
    fn next_timeout(&self) -> Option<Duration> {
        if let Some(delay) = self.restart_delay {
            Some(delay)
        } else if self.intent.wants_tap()
            && matches!(
                self.phase,
                DictationCapability::Untrusted | DictationCapability::Broken
            )
        {
            Some(TRUST_POLL_INTERVAL)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive one step and assert the effect + published phase.
    fn step(s: &mut Supervisor, control: Option<Control>, trusted: bool, now_ms: u64) -> Outcome {
        s.step(control, trusted, now_ms)
    }

    #[test]
    fn a_bound_binding_while_trusted_spawns_the_tap() {
        let mut s = Supervisor::new();
        let out = step(&mut s, Some(Control::Bindings(true)), true, 0);
        assert_eq!(out.effect, Some(Effect::SpawnTap));
        assert_eq!(out.phase, DictationCapability::Active);
        assert_eq!(out.next_timeout, None); // running: block on death or intent
    }

    #[test]
    fn a_bound_binding_while_untrusted_polls_for_the_grant() {
        let mut s = Supervisor::new();
        let out = step(&mut s, Some(Control::Bindings(true)), false, 0);
        assert_eq!(out.effect, None);
        assert_eq!(out.phase, DictationCapability::Untrusted);
        assert_eq!(out.next_timeout, Some(TRUST_POLL_INTERVAL));
    }

    #[test]
    fn the_grant_returning_on_a_poll_tick_spawns_the_tap() {
        let mut s = Supervisor::new();
        step(&mut s, Some(Control::Bindings(true)), false, 0); // -> Untrusted, polling
        let out = step(&mut s, None, true, 500); // poll tick, now trusted
        assert_eq!(out.effect, Some(Effect::SpawnTap));
        assert_eq!(out.phase, DictationCapability::Active);
        assert_eq!(out.next_timeout, None);
    }

    #[test]
    fn clearing_the_last_intent_stops_the_tap_then_settles_inactive() {
        let mut s = Supervisor::new();
        step(&mut s, Some(Control::Bindings(true)), true, 0); // running
        let stop = step(&mut s, Some(Control::Bindings(false)), true, 10);
        assert_eq!(stop.effect, Some(Effect::StopTap));
        assert_eq!(stop.phase, DictationCapability::Inactive);
        // The tap is still believed alive until its death confirms.
        let settled = step(&mut s, Some(Control::TapStopped), true, 20);
        assert_eq!(settled.effect, None);
        assert_eq!(settled.phase, DictationCapability::Inactive);
    }

    #[test]
    fn a_tap_death_while_wanted_and_trusted_schedules_a_backoff_restart() {
        let mut s = Supervisor::new();
        step(&mut s, Some(Control::Bindings(true)), true, 0); // running
        let died = step(&mut s, Some(Control::TapStopped), true, 100);
        assert_eq!(died.effect, None); // no immediate respawn
        assert_eq!(died.phase, DictationCapability::Active); // no flap
        assert_eq!(died.next_timeout, Some(Duration::from_millis(1_000)));
        // The backoff elapses: now it respawns.
        let restart = step(&mut s, None, true, 1_100);
        assert_eq!(restart.effect, Some(Effect::SpawnTap));
        assert_eq!(restart.phase, DictationCapability::Active);
    }

    #[test]
    fn repeated_deaths_within_the_window_exhaust_the_budget_and_go_broken() {
        let mut s = Supervisor::new();
        step(&mut s, Some(Control::Bindings(true)), true, 0);
        // Five deaths each followed by the backoff respawn, all within the window.
        let mut t = 0;
        for _ in 0..RESTART_BACKOFF_MS.len() {
            t += 1;
            let died = step(&mut s, Some(Control::TapStopped), true, t);
            assert_eq!(died.phase, DictationCapability::Active);
            let d = died.next_timeout.expect("a backoff was scheduled");
            t += d.as_millis() as u64;
            assert_eq!(step(&mut s, None, true, t).effect, Some(Effect::SpawnTap));
        }
        // The sixth death has no budget left.
        t += 1;
        let broken = step(&mut s, Some(Control::TapStopped), true, t);
        assert_eq!(broken.effect, None);
        assert_eq!(broken.phase, DictationCapability::Broken);
        assert_eq!(broken.next_timeout, Some(TRUST_POLL_INTERVAL));
    }

    #[test]
    fn a_death_long_after_the_previous_one_resets_the_budget() {
        let mut s = Supervisor::new();
        step(&mut s, Some(Control::Bindings(true)), true, 0);
        // Exhaust the budget so we are at Broken.
        let mut t = 0;
        for _ in 0..RESTART_BACKOFF_MS.len() {
            t += 1;
            let d = step(&mut s, Some(Control::TapStopped), true, t)
                .next_timeout
                .unwrap();
            t += d.as_millis() as u64;
            step(&mut s, None, true, t);
        }
        t += 1;
        assert_eq!(
            step(&mut s, Some(Control::TapStopped), true, t).phase,
            DictationCapability::Broken
        );
        // A trust drop then return recovers from Broken.
        step(&mut s, None, false, t + 1); // poll sees untrusted -> Untrusted
        let recovered = step(&mut s, None, true, t + 2);
        assert_eq!(recovered.effect, Some(Effect::SpawnTap));
        // A fresh death far in the future starts a 1s backoff again, not Broken.
        let died = step(
            &mut s,
            Some(Control::TapStopped),
            true,
            t + RESET_WINDOW_MS + 10,
        );
        assert_eq!(died.phase, DictationCapability::Active);
        assert_eq!(died.next_timeout, Some(Duration::from_millis(1_000)));
    }

    #[test]
    fn an_intent_change_during_a_backoff_interrupts_it_and_respawns_now() {
        let mut s = Supervisor::new();
        step(&mut s, Some(Control::Bindings(true)), true, 0);
        let died = step(&mut s, Some(Control::TapStopped), true, 100);
        assert_eq!(died.next_timeout, Some(Duration::from_millis(1_000)));
        // Auto-paste toggles on mid-backoff: the tap is still wanted and trusted,
        // so it respawns immediately instead of waiting out the backoff.
        let out = step(&mut s, Some(Control::AutoPaste(true)), true, 200);
        assert_eq!(out.effect, Some(Effect::SpawnTap));
        assert_eq!(out.phase, DictationCapability::Active);
        assert_eq!(out.next_timeout, None);
    }

    #[test]
    fn capture_alone_holds_the_tap_from_the_dormant_floor() {
        let mut s = Supervisor::new();
        // No binding bound, but the recorder starts capturing.
        let out = step(&mut s, Some(Control::Capturing(true)), true, 0);
        assert_eq!(out.effect, Some(Effect::SpawnTap));
        assert_eq!(out.phase, DictationCapability::Active);
        // Leaving capture with nothing else wanting it tears the tap down.
        let stop = step(&mut s, Some(Control::Capturing(false)), true, 10);
        assert_eq!(stop.effect, Some(Effect::StopTap));
        assert_eq!(stop.phase, DictationCapability::Inactive);
    }

    #[test]
    fn auto_paste_alone_holds_the_tap_to_track_the_grant() {
        let mut s = Supervisor::new();
        let out = step(&mut s, Some(Control::AutoPaste(true)), true, 0);
        assert_eq!(out.effect, Some(Effect::SpawnTap));
        assert_eq!(out.phase, DictationCapability::Active);
    }

    #[test]
    fn a_death_under_a_revoked_grant_goes_untrusted_not_broken() {
        let mut s = Supervisor::new();
        step(&mut s, Some(Control::Bindings(true)), true, 0); // running
                                                              // The user revoked Accessibility, so the tap died and we are no longer trusted.
        let out = step(&mut s, Some(Control::TapStopped), false, 100);
        assert_eq!(out.effect, None);
        assert_eq!(out.phase, DictationCapability::Untrusted);
        assert_eq!(out.next_timeout, Some(TRUST_POLL_INTERVAL));
    }

    #[test]
    fn multiple_reasons_keep_the_tap_until_the_last_one_leaves() {
        let mut s = Supervisor::new();
        step(&mut s, Some(Control::Bindings(true)), true, 0);
        step(&mut s, Some(Control::AutoPaste(true)), true, 10);
        // Dropping the binding alone does not stop the tap: auto-paste still wants it.
        let still = step(&mut s, Some(Control::Bindings(false)), true, 20);
        assert_eq!(still.effect, None);
        assert_eq!(still.phase, DictationCapability::Active);
        // Dropping auto-paste too finally stops it.
        let stop = step(&mut s, Some(Control::AutoPaste(false)), true, 30);
        assert_eq!(stop.effect, Some(Effect::StopTap));
        assert_eq!(stop.phase, DictationCapability::Inactive);
    }
}
