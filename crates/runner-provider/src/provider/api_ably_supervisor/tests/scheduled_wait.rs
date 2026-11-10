use std::future::{Future, poll_fn};

use tokio::sync::oneshot;
use tokio::time::Instant;

use super::super::{PollReason, PollWakeups};

#[derive(Debug)]
pub(in crate::provider::api_ably_supervisor) struct ScheduledWaitObserver {
    reuse: bool,
    ready: oneshot::Sender<Instant>,
}

impl PollWakeups {
    pub(in crate::provider) fn observe_next_fast_poll_for_test(
        &self,
        reuse: bool,
    ) -> oneshot::Receiver<Instant> {
        let (ready, received) = oneshot::channel();
        let mut inner = self.lock_inner();
        assert!(inner.scheduled_wait_observer.is_none());
        inner.scheduled_wait_observer = Some(ScheduledWaitObserver { reuse, ready });
        received
    }

    pub(in crate::provider::api_ably_supervisor) async fn scheduled_sleep_for_test(
        &self,
        at: Instant,
        reason: PollReason,
        reuse: bool,
    ) {
        let sleep = tokio::time::sleep_until(at);
        tokio::pin!(sleep);
        poll_fn(|cx| {
            let result = sleep.as_mut().poll(cx);
            if result.is_pending() {
                let observer = {
                    let mut inner = self.lock_inner();
                    if reason == PollReason::Fast
                        && inner
                            .scheduled_wait_observer
                            .as_ref()
                            .is_some_and(|observer| observer.reuse == reuse)
                    {
                        inner.scheduled_wait_observer.take()
                    } else {
                        None
                    }
                };
                if let Some(observer) = observer {
                    // Dropping an observer must not cancel the scheduler.
                    let _ = observer.ready.send(at);
                }
            }
            result
        })
        .await;
    }
}
