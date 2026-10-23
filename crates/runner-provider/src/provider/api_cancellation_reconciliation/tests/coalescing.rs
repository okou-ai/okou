use super::*;
use futures_util::FutureExt;
use raw_http_test_support::clock::advance_timer_phase;
use std::panic::AssertUnwindSafe;
use tokio::sync::Notify;
use tracing_subscriber::{Layer, layer::Context};

#[derive(Clone, Default)]
struct ObservedIntents {
    events: CapturedEvents,
    changed: Arc<Notify>,
}

impl<S: tracing::Subscriber> Layer<S> for ObservedIntents {
    fn on_event(&self, event: &tracing::Event<'_>, context: Context<'_, S>) {
        self.events.on_event(event, context);
        self.changed.notify_one();
    }
}

impl ObservedIntents {
    fn contains(&self, run_id: RunId, mode: Mode) -> bool {
        let run_id = run_id.to_string();
        let mode = format!("{mode:?}");
        self.events.entries().iter().any(|event| {
            event.fields.get("message").map(String::as_str)
                == Some("cancellation reconciliation observed stop intent")
                && event.fields.get("run_id") == Some(&run_id)
                && event.fields.get("mode") == Some(&mode)
        })
    }

    async fn wait_for(&self, run_id: RunId, mode: Mode) {
        timeout(Duration::from_secs(5), async {
            while !self.contains(run_id, mode) {
                self.changed.notified().await;
            }
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn blocked_gate_does_not_hold_http_capacity_and_hard_coalesces() {
    let mut server = Server::new().await;
    let controller = server.controller();
    let registry = RunCancellationRegistry::new();
    let blocked_id = RunId::new_v4();
    let blocked = registry.register(blocked_id).await.unwrap();
    let control_id = RunId::new_v4();
    let control = registry.register(control_id).await.unwrap();
    let third_id = RunId::new_v4();
    let third = registry.register(third_id).await.unwrap();
    let mut gate = Some(blocked.handle().transfer_guard().await);
    let observed = ObservedIntents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(observed.clone()));

    let result = AssertUnwindSafe(async {
        assert!(controller.observe(blocked_id, blocked.handle(), "blocked-token".into()));
        server
            .next()
            .await
            .mode(blocked_id, Some("cooperative"))
            .await;
        observed.wait_for(blocked_id, Mode::Cooperative).await;
        assert!(controller.observe(control_id, control.handle(), "control-token".into()));
        server.next().await.mode(control_id, Some("hard")).await;
        bounded(control.handle().signals().hard().cancelled()).await;
        assert!(!blocked.is_cancelled());

        advance_timer_phase(INTERVAL).await;
        let first = server.next().await;
        let second = server.next().await;
        let (blocked_hard, control_poll) = if first.run_id() == blocked_id {
            (first, second)
        } else {
            (second, first)
        };
        assert_eq!(blocked_hard.run_id(), blocked_id);
        assert_eq!(control_poll.run_id(), control_id);
        control_poll.mode(control_id, Some("hard")).await;

        // Other Runs can finish while this Run's Hard response is still held.
        // Their cancellation cannot acknowledge its watch publication.
        assert!(controller.observe(third_id, third.handle(), "third-token".into()));
        server.next().await.mode(third_id, Some("hard")).await;
        bounded(third.handle().signals().hard().cancelled()).await;
        assert!(!blocked.is_cancelled());
        assert!(!observed.contains(blocked_id, Mode::Hard));
        blocked_hard.mode(blocked_id, Some("hard")).await;

        // This exact Run's event is emitted after Hard reaches its watch.
        observed.wait_for(blocked_id, Mode::Hard).await;
        drop(gate.take());
        bounded(blocked.handle().signals().hard().cancelled()).await;
        assert!(!blocked.handle().signals().cooperative_user().is_cancelled());
    })
    .catch_unwind()
    .await;

    // Join the real owners before propagating an assertion failure.
    drop(gate);
    for registration in [&blocked, &control, &third] {
        bounded(registration.unregister()).await;
    }
    bounded(controller.shutdown()).await;
    server.task.abort();
    assert!(bounded(&mut server.task).await.unwrap_err().is_cancelled());
    assert!(controller.tasks.is_empty());
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}
