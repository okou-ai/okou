//! Per-body Future/Wake observations, with one allocation per attempt.
//!
//! Poll wall is not CPU time, and a wake is not proof of data readiness.
//! First-wake-to-next-poll wall can overlap a poll that woke itself; these
//! aggregates must not be added or subtracted to infer pure network time.
//! Counts include terminal/error polls. Wakes without a subsequent poll and
//! repolls without an observed wake retain the limits of resumption coverage.

use std::future::{Future, poll_fn};
use std::pin::pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Wake, Waker};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct HistoryBodyPollStats {
    pub polls: u32,
    pub pending_polls: u32,
    pub incomplete_polls: u32,
    pub poll_wall: Duration,
    pub wakes: u32,
    pub wake_to_poll_count: u32,
    pub wake_to_poll_wall: Duration,
    pub wake_to_poll_max: Duration,
    pub polls_without_wake: u32,
    pub unconsumed_wakes: u32,
    pub saturated: bool,
}

fn increment(count: &mut u32, saturated: &mut bool) {
    add_count(count, 1, saturated);
}

fn add_count(count: &mut u32, amount: u32, saturated: &mut bool) {
    match count.checked_add(amount) {
        Some(next) => *count = next,
        None => {
            *count = u32::MAX;
            *saturated = true;
        }
    }
}

#[derive(Default)]
struct State {
    stats: HistoryBodyPollStats,
    parent: Option<Waker>,
    first_wake: Option<Instant>,
    first_poll: bool,
    pending_wakes: u32,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        // Recovery preserves task-waker retirement during unwind. A poisoned
        // observer never publishes its potentially incomplete counters.
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn forward_wake(&self) {
        let parent = {
            let mut state = self.lock();
            let Some(parent) = state.parent.as_ref().cloned() else {
                return;
            };
            let stats = &mut state.stats;
            increment(&mut stats.wakes, &mut stats.saturated);
            let mut saturated = state.stats.saturated;
            increment(&mut state.pending_wakes, &mut saturated);
            state.stats.saturated = saturated;
            state.first_wake.get_or_insert_with(Instant::now);
            parent
        };
        // A callback already in flight can forward its captured parent once.
        // A wake starting after detachment cannot acquire the retired parent.
        parent.wake();
    }

    fn finish_await(&self) {
        let mut state = self.lock();
        let parent = state.parent.take();
        let pending_wakes = std::mem::take(&mut state.pending_wakes);
        if state.first_wake.take().is_some() {
            let stats = &mut state.stats;
            add_count(
                &mut stats.unconsumed_wakes,
                pending_wakes,
                &mut stats.saturated,
            );
        }
        drop(state);
        // Custom waker destruction must also stay outside observation locks.
        drop(parent);
    }
}

impl Wake for Shared {
    fn wake(self: Arc<Self>) {
        self.forward_wake();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.forward_wake();
    }
}

/// One owner observes serial awaits; its clone is used only to read snapshots.
#[derive(Clone)]
pub(super) struct HistoryBodyPollObserver {
    shared: Arc<Shared>,
    waker: Waker,
}

impl HistoryBodyPollObserver {
    pub fn new() -> Self {
        let shared = Arc::new(Shared::default());
        let waker = Waker::from(Arc::clone(&shared));
        Self { shared, waker }
    }

    pub fn snapshot(&self) -> Option<HistoryBodyPollStats> {
        self.shared.state.lock().ok().map(|state| state.stats)
    }

    pub async fn observe<F: Future>(&self, future: F) -> F::Output {
        self.shared.lock().first_poll = true;
        let _await_guard = AwaitGuard(&self.shared);
        let mut future = pin!(future);
        poll_fn(|context| {
            let poll_guard = self.enter_poll(context.waker());
            let result = future.as_mut().poll(&mut Context::from_waker(&self.waker));
            poll_guard.finish(result.is_pending());
            result
        })
        .await
    }

    fn enter_poll(&self, parent: &Waker) -> PollGuard<'_> {
        let previous_parent = {
            let mut state = self.shared.lock();
            let previous_parent = if state
                .parent
                .as_ref()
                .is_none_or(|previous| !previous.will_wake(parent))
            {
                state.parent.replace(parent.clone())
            } else {
                None
            };
            let wake = state.first_wake.take();
            state.pending_wakes = 0;
            if state.first_poll {
                state.first_poll = false;
            } else {
                let stats = &mut state.stats;
                if let Some(wake) = wake {
                    let elapsed = wake.elapsed();
                    increment(&mut stats.wake_to_poll_count, &mut stats.saturated);
                    stats.wake_to_poll_wall += elapsed;
                    stats.wake_to_poll_max = stats.wake_to_poll_max.max(elapsed);
                } else {
                    increment(&mut stats.polls_without_wake, &mut stats.saturated);
                }
            }
            let stats = &mut state.stats;
            increment(&mut stats.polls, &mut stats.saturated);
            previous_parent
        };
        drop(previous_parent);
        PollGuard {
            shared: &self.shared,
            started: Instant::now(),
            pending: None,
        }
    }
}

struct AwaitGuard<'a>(&'a Shared);

impl Drop for AwaitGuard<'_> {
    fn drop(&mut self) {
        self.0.finish_await();
    }
}

struct PollGuard<'a> {
    shared: &'a Shared,
    started: Instant,
    pending: Option<bool>,
}

impl PollGuard<'_> {
    fn finish(mut self, pending: bool) {
        self.pending = Some(pending);
    }
}

impl Drop for PollGuard<'_> {
    fn drop(&mut self) {
        let elapsed = self.started.elapsed();
        let mut state = self.shared.lock();
        let stats = &mut state.stats;
        stats.poll_wall += elapsed;
        match self.pending {
            Some(true) => increment(&mut stats.pending_polls, &mut stats.saturated),
            Some(false) => {}
            None => increment(&mut stats.incomplete_polls, &mut stats.saturated),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::hint::black_box;
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::task::Poll;

    #[derive(Default)]
    struct TaskWake(AtomicUsize);

    impl Wake for TaskWake {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }

        fn wake_by_ref(self: &Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[derive(Default)]
    struct Transport {
        waker: Mutex<Option<Waker>>,
        ready: AtomicUsize,
    }

    struct Read(Arc<Transport>);

    impl Future for Read {
        type Output = Result<Option<u8>, &'static str>;

        fn poll(self: std::pin::Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
            *self.0.waker.lock().unwrap() = Some(context.waker().clone());
            match self.0.ready.load(Ordering::SeqCst) {
                0 => Poll::Pending,
                1 => Poll::Ready(Ok(Some(7))),
                2 => Poll::Ready(Ok(None)),
                _ => Poll::Ready(Err("controlled transport failure")),
            }
        }
    }

    #[test]
    fn forwards_coalesced_wakes_and_replaces_the_parent() {
        let observer = HistoryBodyPollObserver::new();
        let transport = Arc::new(Transport::default());
        let first = Arc::new(TaskWake::default());
        let second = Arc::new(TaskWake::default());
        let first_waker = Waker::from(Arc::clone(&first));
        let second_waker = Waker::from(Arc::clone(&second));
        let mut read = pin!(observer.observe(Read(Arc::clone(&transport))));
        assert!(
            read.as_mut()
                .poll(&mut Context::from_waker(&first_waker))
                .is_pending()
        );
        let retained = transport.waker.lock().unwrap().as_ref().unwrap().clone();
        retained.wake_by_ref();
        retained.wake_by_ref();
        assert_eq!(first.0.load(Ordering::SeqCst), 2);
        assert!(
            read.as_mut()
                .poll(&mut Context::from_waker(&second_waker))
                .is_pending()
        );
        retained.wake_by_ref();
        assert_eq!(second.0.load(Ordering::SeqCst), 1);
        transport.ready.store(1, Ordering::SeqCst);
        assert_eq!(
            read.as_mut().poll(&mut Context::from_waker(&second_waker)),
            Poll::Ready(Ok(Some(7)))
        );
        let stats = observer.snapshot().unwrap();
        assert_eq!(
            (stats.polls, stats.pending_polls, stats.incomplete_polls),
            (3, 2, 0)
        );
        assert_eq!((stats.wakes, stats.wake_to_poll_count), (3, 2));
        assert_eq!((stats.polls_without_wake, stats.unconsumed_wakes), (0, 0));
        retained.wake_by_ref();
        assert_eq!(second.0.load(Ordering::SeqCst), 1);
        assert_eq!(observer.snapshot().unwrap().wakes, 3);
    }

    #[test]
    fn retains_missing_wake_coverage_and_terminal_results() {
        for result in [2, 3] {
            let observer = HistoryBodyPollObserver::new();
            let transport = Arc::new(Transport::default());
            let waker = Waker::from(Arc::new(TaskWake::default()));
            let mut read = pin!(observer.observe(Read(Arc::clone(&transport))));
            assert!(
                read.as_mut()
                    .poll(&mut Context::from_waker(&waker))
                    .is_pending()
            );
            transport.ready.store(result, Ordering::SeqCst);
            let outcome = read.as_mut().poll(&mut Context::from_waker(&waker));
            assert_eq!(
                outcome,
                if result == 2 {
                    Poll::Ready(Ok(None))
                } else {
                    Poll::Ready(Err("controlled transport failure"))
                }
            );
            let stats = observer.snapshot().unwrap();
            assert_eq!(
                (stats.polls, stats.pending_polls, stats.polls_without_wake),
                (2, 1, 1)
            );
            assert_eq!((stats.wakes, stats.wake_to_poll_count), (0, 0));
        }
    }

    #[test]
    fn drop_retires_the_task_even_when_transport_retains_its_waker() {
        let observer = HistoryBodyPollObserver::new();
        let transport = Arc::new(Transport::default());
        let task = Arc::new(TaskWake::default());
        let retired_task = Arc::downgrade(&task);
        let parent = Waker::from(task);
        let mut read = Box::pin(observer.observe(Read(Arc::clone(&transport))));
        assert!(
            read.as_mut()
                .poll(&mut Context::from_waker(&parent))
                .is_pending()
        );
        let retained = transport.waker.lock().unwrap().as_ref().unwrap().clone();
        retained.wake_by_ref();
        retained.wake_by_ref();
        retained.wake_by_ref();
        drop(parent);
        drop(read);
        assert!(retired_task.upgrade().is_none());
        retained.wake_by_ref();
        let stats = observer.snapshot().unwrap();
        assert_eq!(
            (stats.polls, stats.pending_polls, stats.incomplete_polls),
            (1, 1, 0)
        );
        assert_eq!(
            (
                stats.wakes,
                stats.unconsumed_wakes,
                stats.wake_to_poll_count
            ),
            (3, 3, 0)
        );
    }

    #[test]
    fn self_wake_is_observed_without_fabricating_ready_or_disjoint_wall() {
        let observer = HistoryBodyPollObserver::new();
        let waker = Waker::from(Arc::new(TaskWake::default()));
        let mut first = true;
        let future = poll_fn(|context| {
            if std::mem::take(&mut first) {
                context.waker().wake_by_ref();
                Poll::Pending
            } else {
                Poll::Ready(())
            }
        });
        let mut observed = pin!(observer.observe(future));
        assert!(
            observed
                .as_mut()
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
        );
        assert!(
            observed
                .as_mut()
                .poll(&mut Context::from_waker(&waker))
                .is_ready()
        );
        let stats = observer.snapshot().unwrap();
        assert_eq!(
            (
                stats.polls,
                stats.pending_polls,
                stats.wakes,
                stats.wake_to_poll_count
            ),
            (2, 1, 1, 1)
        );
    }

    #[test]
    fn unwinding_poll_is_incomplete_and_drop_detaches_the_parent() {
        let observer = HistoryBodyPollObserver::new();
        let parent = Waker::from(Arc::new(TaskWake::default()));
        let mut observed = Box::pin(observer.observe(poll_fn(|context| -> Poll<()> {
            context.waker().wake_by_ref();
            panic!("controlled poll panic")
        })));
        assert!(
            catch_unwind(AssertUnwindSafe(|| observed
                .as_mut()
                .poll(&mut Context::from_waker(&parent))))
            .is_err()
        );
        drop(observed);
        assert!(observer.shared.lock().parent.is_none());
        let stats = observer.snapshot().unwrap();
        assert_eq!(
            (stats.polls, stats.pending_polls, stats.incomplete_polls),
            (1, 0, 1)
        );
        assert_eq!((stats.wakes, stats.unconsumed_wakes), (1, 1));
    }

    #[test]
    fn serial_ready_awaits_do_not_infer_resumption_without_a_wake() {
        let observer = HistoryBodyPollObserver::new();
        let waker = Waker::from(Arc::new(TaskWake::default()));
        for value in [11, 12] {
            let mut future = pin!(observer.observe(std::future::ready(value)));
            assert_eq!(
                future.as_mut().poll(&mut Context::from_waker(&waker)),
                Poll::Ready(value)
            );
        }
        let stats = observer.snapshot().unwrap();
        assert_eq!(
            (stats.polls, stats.pending_polls, stats.incomplete_polls),
            (2, 0, 0)
        );
        assert_eq!(
            (
                stats.wakes,
                stats.wake_to_poll_count,
                stats.polls_without_wake
            ),
            (0, 0, 0)
        );
    }

    #[test]
    #[ignore = "manual observer-cost measurement, with no timing threshold"]
    fn measure_ready_poll_observer_cost() {
        let waker = Waker::from(Arc::new(TaskWake::default()));
        let mut context = Context::from_waker(&waker);
        let count = 100_000;
        let started = Instant::now();
        for value in 0..count {
            let mut future = pin!(std::future::ready(black_box(value)));
            let _ = black_box(future.as_mut().poll(&mut context));
        }
        let baseline = started.elapsed();
        let observer = HistoryBodyPollObserver::new();
        let started = Instant::now();
        for value in 0..count {
            let mut future = pin!(observer.observe(std::future::ready(black_box(value))));
            let _ = black_box(future.as_mut().poll(&mut context));
        }
        let observed = started.elapsed();
        assert_eq!(observer.snapshot().unwrap().polls, count);
        println!(
            "ready polls={count} baseline_ns={} observed_ns={} added_ns_per_poll={}",
            baseline.as_nanos(),
            observed.as_nanos(),
            observed.saturating_sub(baseline).as_nanos() / u128::from(count)
        );
    }
}
