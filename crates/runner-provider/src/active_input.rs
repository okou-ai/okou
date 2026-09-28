use std::time::Duration;

use guest_contracts::active_input::encoded_active_input_len;
use tokio::sync::broadcast;
use uuid::Uuid;

use api_contracts::generated::{
    constants::runners::ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES as ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES_U64,
    types::runners::runs::steerable_inputs::next::Response as NextSteerableInputResponse,
};

use crate::error::ProviderResult;
use crate::local_queue::{ActiveInputEntry, LocalQueue};
use crate::provider::ApiClient;
use runner_types::ids::RunId;

/// Shared active-input payload limit across API, vsock, and guest process-control IPC.
pub const ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES: usize =
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES_U64 as usize;
const _: () = assert!(
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES == guest_control_proto::EXEC_CONTROL_MAX_PAYLOAD_BYTES,
    "API active-input payload limit must match the vsock exec-control limit",
);
const _: () = assert!(
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES == process_control_ipc::MAX_CONTROL_PAYLOAD_BYTES,
    "API active-input payload limit must match the guest process-control IPC limit",
);

pub fn identified_active_input_payload_len(text: &str) -> Result<usize, serde_json::Error> {
    let event_id = Uuid::nil().hyphenated().to_string();
    encoded_active_input_len(&event_id, text)
}

/// Stable input identity for a local-queue entry, which has no chat event.
pub fn local_active_input_event_id(run_id: RunId, sequence: u64) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("vm0:local-active-input:{run_id}:{sequence}").as_bytes(),
    )
    .hyphenated()
    .to_string()
}

pub enum ActiveInputSource {
    LocalQueue(LocalQueueActiveInputSource),
    Api(ApiActiveInputSource),
}

#[derive(Clone)]
pub struct LocalQueueActiveInputSource {
    pub queue: LocalQueue,
    pub run_id: RunId,
}

pub struct ApiActiveInputSource {
    api: ApiClient,
    run_id: RunId,
    sandbox_token: String,
    notifications: ActiveInputSubscription,
}

pub enum ActiveInputBatch {
    Local(Vec<ActiveInputEntry>),
    Api(NextSteerableInputResponse),
}

const LOCAL_ACTIVE_INPUT_POLL_INTERVAL: Duration = Duration::from_millis(250);
const ACTIVE_INPUT_NOTIFICATION_CAPACITY: usize = 256;

/// Wakes API active-input readers. A reader only reads on its first pass and
/// after a wakeup: there is no periodic recheck and no read retry.
#[derive(Clone)]
pub struct ActiveInputNotifications {
    sender: broadcast::Sender<ActiveInputWake>,
}

#[derive(Clone, Copy, Debug)]
enum ActiveInputWake {
    /// An `active-input` push for one run.
    Run(RunId),
    /// Every active run: pushes may have been lost while Ably was disconnected.
    All,
}

pub struct ActiveInputSubscription {
    run_id: RunId,
    receiver: broadcast::Receiver<ActiveInputWake>,
}

impl ActiveInputNotifications {
    pub fn new() -> Self {
        let (sender, receiver) = broadcast::channel(ACTIVE_INPUT_NOTIFICATION_CAPACITY);
        drop(receiver);
        Self { sender }
    }

    pub fn subscribe(&self, run_id: RunId) -> ActiveInputSubscription {
        ActiveInputSubscription {
            run_id,
            receiver: self.sender.subscribe(),
        }
    }

    pub fn notify(&self, run_id: RunId) {
        let _ = self.sender.send(ActiveInputWake::Run(run_id));
    }

    /// Wake every subscribed run once, e.g. after Ably reconnects.
    pub fn notify_all(&self) {
        let _ = self.sender.send(ActiveInputWake::All);
    }
}

impl Default for ActiveInputNotifications {
    fn default() -> Self {
        Self::new()
    }
}

impl ActiveInputSubscription {
    pub(crate) async fn wait(&mut self) {
        loop {
            match self.receiver.recv().await {
                Ok(ActiveInputWake::Run(run_id)) if run_id == self.run_id => return,
                Ok(ActiveInputWake::All) => return,
                Ok(ActiveInputWake::Run(_)) => {}
                // A lagged receiver may have missed its own wakeup.
                Err(broadcast::error::RecvError::Lagged(_)) => return,
                // No wakeup can arrive any more; never spin on a closed channel.
                Err(broadcast::error::RecvError::Closed) => std::future::pending::<()>().await,
            }
        }
    }
}

impl ActiveInputSource {
    pub fn local_queue(queue: LocalQueue, run_id: RunId) -> Self {
        Self::LocalQueue(LocalQueueActiveInputSource { queue, run_id })
    }

    pub fn api(
        api: ApiClient,
        run_id: RunId,
        sandbox_token: String,
        notifications: ActiveInputSubscription,
    ) -> Self {
        Self::Api(ApiActiveInputSource {
            api,
            run_id,
            sandbox_token,
            notifications,
        })
    }

    pub async fn read(&mut self, min_sequence: u64) -> ProviderResult<ActiveInputBatch> {
        match self {
            Self::LocalQueue(source) => {
                let source = source.clone();
                let entries = tokio::task::spawn_blocking(move || {
                    source
                        .queue
                        .read_active_input_entries_from_sequence_sync(source.run_id, min_sequence)
                })
                .await
                .map_err(|error| {
                    crate::error::ProviderError::Internal(format!(
                        "active-input reader task failed: {error}"
                    ))
                })?;
                Ok(ActiveInputBatch::Local(entries))
            }
            Self::Api(source) => read_api_active_input(source).await,
        }
    }

    /// Local queues poll; API sources wait for a run or reconnect wakeup.
    /// The caller owns cancellation.
    pub async fn wait_until_next_read(&mut self) {
        match self {
            Self::LocalQueue(_) => tokio::time::sleep(LOCAL_ACTIVE_INPUT_POLL_INTERVAL).await,
            Self::Api(source) => source.notifications.wait().await,
        }
    }
}

async fn read_api_active_input(source: &ApiActiveInputSource) -> ProviderResult<ActiveInputBatch> {
    source
        .api
        .next_steerable_input(source.run_id, &source.sandbox_token)
        .await
        .map(ActiveInputBatch::Api)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::ActiveInputNotifications;
    use runner_types::ids::RunId;

    const WAKE_TIMEOUT: Duration = Duration::from_secs(5);
    const NO_WAKE: Duration = Duration::from_millis(20);

    #[tokio::test]
    async fn run_notification_wakes_only_that_run() {
        let notifications = ActiveInputNotifications::new();
        let target = RunId::new_v4();
        let mut target_subscription = notifications.subscribe(target);
        let mut other_subscription = notifications.subscribe(RunId::new_v4());

        notifications.notify(target);

        tokio::time::timeout(WAKE_TIMEOUT, target_subscription.wait())
            .await
            .expect("the notified run wakes");
        assert!(
            tokio::time::timeout(NO_WAKE, other_subscription.wait())
                .await
                .is_err(),
            "another run's notification must not wake this run"
        );
    }

    #[tokio::test]
    async fn notify_all_wakes_every_run_once() {
        let notifications = ActiveInputNotifications::new();
        let mut subscriptions =
            [RunId::new_v4(), RunId::new_v4()].map(|run_id| notifications.subscribe(run_id));

        notifications.notify_all();

        for subscription in &mut subscriptions {
            tokio::time::timeout(WAKE_TIMEOUT, subscription.wait())
                .await
                .expect("every run wakes");
            assert!(
                tokio::time::timeout(NO_WAKE, subscription.wait())
                    .await
                    .is_err(),
                "one broadcast wakes each run exactly once"
            );
        }
    }

    #[tokio::test]
    async fn closed_notifications_never_wake() {
        let notifications = ActiveInputNotifications::new();
        let mut subscription = notifications.subscribe(RunId::new_v4());
        drop(notifications);

        assert!(
            tokio::time::timeout(NO_WAKE, subscription.wait())
                .await
                .is_err(),
            "a closed channel must not turn into a read loop"
        );
    }
}
