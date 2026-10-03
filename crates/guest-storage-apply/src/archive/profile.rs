//! Local-test observation only; this module and every hook are absent from ordinary builds.
//!
//! Nested scope durations are subtracted within each sample, not from aggregate percentiles.
//! Reader wrappers forward the original read result, including EOF and errors.

use std::cell::RefCell;
use std::io::{self, Read};
use std::marker::PhantomData;
use std::rc::Rc;
use std::time::Instant;

mod fixtures;
mod tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(usize)]
pub(super) enum Phase {
    CompressedRead,
    GzipRead,
    TarMetadata,
    EntryValidation,
    Unpack,
    Trailer,
}

const PHASES: [Phase; 6] = [
    Phase::CompressedRead,
    Phase::GzipRead,
    Phase::TarMetadata,
    Phase::EntryValidation,
    Phase::Unpack,
    Phase::Trailer,
];

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::CompressedRead => "compressed_read",
            Self::GzipRead => "gzip_read",
            Self::TarMetadata => "tar_metadata",
            Self::EntryValidation => "entry_validation",
            Self::Unpack => "unpack",
            Self::Trailer => "trailer",
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct PhaseStats {
    calls: u64,
    inclusive_ns: u64,
    exclusive_ns: u64,
}

#[derive(Debug, Default)]
pub(super) struct Profile {
    phases: [PhaseStats; PHASES.len()],
}

impl Profile {
    fn json(&self) -> serde_json::Value {
        serde_json::Value::Object(
            PHASES
                .iter()
                .map(|phase| {
                    let stats = self.phases[*phase as usize];
                    (
                        phase.name().to_owned(),
                        serde_json::json!({
                            "calls": stats.calls,
                            "inclusive_ns": stats.inclusive_ns,
                            "exclusive_ns": stats.exclusive_ns,
                        }),
                    )
                })
                .collect(),
        )
    }

    fn exclusive_ns(&self) -> u64 {
        self.phases.iter().map(|phase| phase.exclusive_ns).sum()
    }
}

struct Frame {
    phase: Phase,
    started: Instant,
    children_ns: u64,
}

#[derive(Default)]
struct ActiveProfile {
    profile: Profile,
    stack: Vec<Frame>,
}

thread_local! {
    static ACTIVE: RefCell<Option<ActiveProfile>> = const { RefCell::new(None) };
}

// Rc's marker makes session/scope ownership thread-bound without retaining an allocation.
struct Session {
    finished: bool,
    _thread_bound: PhantomData<Rc<()>>,
}

impl Session {
    fn start() -> Self {
        ACTIVE.with(|active| {
            let mut active = active.borrow_mut();
            assert!(active.is_none(), "archive profile sessions cannot nest");
            *active = Some(ActiveProfile::default());
        });
        Self {
            finished: false,
            _thread_bound: PhantomData,
        }
    }

    fn finish(mut self) -> Profile {
        let profile = ACTIVE.with(|active| {
            let mut active = active.borrow_mut();
            let state = active.as_ref().expect("archive profile session is active");
            assert!(
                state.stack.is_empty(),
                "archive profile scopes must finish first"
            );
            active
                .take()
                .expect("archive profile session is active")
                .profile
        });
        self.finished = true;
        profile
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if !self.finished {
            // Also clear state after an extractor panic; subsequent tests must start fresh.
            ACTIVE.with(|active| *active.borrow_mut() = None);
        }
    }
}

pub(super) fn collect<T>(operation: impl FnOnce() -> T) -> (T, Profile) {
    let session = Session::start();
    let result = operation();
    (result, session.finish())
}

pub(super) struct Scope {
    phase: Phase,
    depth: usize,
    _thread_bound: PhantomData<Rc<()>>,
}

pub(super) fn scope(phase: Phase) -> Option<Scope> {
    ACTIVE.with(|active| {
        let mut active = active.borrow_mut();
        let state = active.as_mut()?;
        state.stack.push(Frame {
            phase,
            started: Instant::now(),
            children_ns: 0,
        });
        Some(Scope {
            phase,
            depth: state.stack.len(),
            _thread_bound: PhantomData,
        })
    })
}

impl Drop for Scope {
    fn drop(&mut self) {
        ACTIVE.with(|active| {
            let mut active = active.borrow_mut();
            // An unfinished session can be discarded during unwind. It produces no report.
            let Some(state) = active.as_mut() else {
                return;
            };
            assert_eq!(
                state.stack.len(),
                self.depth,
                "archive profile scope nesting"
            );
            let frame = state.stack.pop().expect("archive profile scope is active");
            assert_eq!(frame.phase, self.phase, "archive profile scope nesting");
            let elapsed_ns = u64::try_from(frame.started.elapsed().as_nanos())
                .expect("a bounded archive profile interval fits u64 nanoseconds");
            let stats = &mut state.profile.phases[self.phase as usize];
            stats.calls += 1;
            stats.inclusive_ns += elapsed_ns;
            stats.exclusive_ns += elapsed_ns
                .checked_sub(frame.children_ns)
                .expect("nested intervals cannot exceed their parent");
            if let Some(parent) = state.stack.last_mut() {
                parent.children_ns += elapsed_ns;
            }
        });
    }
}

pub(super) struct TimedReader<R> {
    reader: R,
    phase: Phase,
}

pub(super) fn reader<R: Read>(reader: R, phase: Phase) -> TimedReader<R> {
    TimedReader { reader, phase }
}

impl<R: Read> Read for TimedReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let _scope = scope(self.phase);
        self.reader.read(buffer)
    }
}
