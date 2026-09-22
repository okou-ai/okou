use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;

use guest_contracts::active_input::encoded_active_input_len;
use tokio::sync::broadcast;
use uuid::Uuid;

use api_contracts::generated::{
    constants::runners::ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES as ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES_U64,
    types::runners::runs::active_inputs::{
        receipt::Response as ActiveInputReceiptResponse,
        reserve::Response as ActiveInputReserveResponse,
    },
};

use crate::error::RunnerResult;
use crate::local_queue::{ActiveInputEntry, LocalQueue};
use crate::provider::ApiClient;
use runner_types::ids::RunId;

/// Shared active-input payload limit across API, vsock, and guest process-control IPC.
pub(crate) const ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES: usize =
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES_U64 as usize;
const _: () = assert!(
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES == guest_control_proto::EXEC_CONTROL_MAX_PAYLOAD_BYTES,
    "API active-input payload limit must match the vsock exec-control limit",
);
const _: () = assert!(
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES == process_control_ipc::MAX_CONTROL_PAYLOAD_BYTES,
    "API active-input payload limit must match the guest process-control IPC limit",
);

pub(crate) fn identified_active_input_payload_len(text: &str) -> Result<usize, serde_json::Error> {
    let delivery_id = Uuid::nil().hyphenated().to_string();
    encoded_active_input_len(&delivery_id, text)
}

pub(crate) fn local_active_input_delivery_id(run_id: RunId, sequence: u64) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("vm0:local-active-input:{run_id}:{sequence}").as_bytes(),
    )
    .hyphenated()
    .to_string()
}

pub(crate) enum ActiveInputSource {
    LocalQueue(LocalQueueActiveInputSource),
    Api(ApiActiveInputSource),
}

#[derive(Clone)]
pub(crate) struct LocalQueueActiveInputSource {
    pub(crate) queue: LocalQueue,
    pub(crate) run_id: RunId,
}

pub(crate) struct ApiActiveInputSource {
    api: ApiClient,
    run_id: RunId,
    sandbox_token: String,
    notifications: ActiveInputSubscription,
    consecutive_read_failures: u32,
}

#[derive(Clone)]
pub(crate) struct ApiActiveInputRecovery {
    api: ApiClient,
    run_id: RunId,
    sandbox_token: String,
}

pub(crate) enum ActiveInputBatch {
    Local(Vec<ActiveInputEntry>),
    Api(ActiveInputReserveResponse),
}

const LOCAL_ACTIVE_INPUT_POLL_INTERVAL: Duration = Duration::from_millis(250);
pub(crate) const API_ACTIVE_INPUT_RECHECK_INTERVAL: Duration = Duration::from_secs(30);
const ACTIVE_INPUT_NOTIFICATION_CAPACITY: usize = 256;
const API_ACTIVE_INPUT_RETRY_INITIAL_INTERVAL: Duration = Duration::from_millis(250);
const API_ACTIVE_INPUT_RETRY_MAX_INTERVAL: Duration = Duration::from_secs(4);

#[derive(Clone)]
pub(crate) struct ActiveInputNotifications {
    sender: broadcast::Sender<RunId>,
}

pub(crate) struct ActiveInputSubscription {
    run_id: RunId,
    receiver: broadcast::Receiver<RunId>,
}

impl ActiveInputNotifications {
    pub(crate) fn new() -> Self {
        let (sender, receiver) = broadcast::channel(ACTIVE_INPUT_NOTIFICATION_CAPACITY);
        drop(receiver);
        Self { sender }
    }

    pub(crate) fn subscribe(&self, run_id: RunId) -> ActiveInputSubscription {
        ActiveInputSubscription {
            run_id,
            receiver: self.sender.subscribe(),
        }
    }

    pub(crate) fn notify(&self, run_id: RunId) {
        let _ = self.sender.send(run_id);
    }
}

impl ActiveInputSubscription {
    async fn wait(&mut self) {
        loop {
            match self.receiver.recv().await {
                Ok(run_id) if run_id == self.run_id => return,
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => return,
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }
}

impl ActiveInputSource {
    pub(crate) fn local_queue(queue: LocalQueue, run_id: RunId) -> Self {
        Self::LocalQueue(LocalQueueActiveInputSource { queue, run_id })
    }

    pub(crate) fn api(
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
            consecutive_read_failures: 0,
        })
    }

    pub(crate) fn api_recovery(&self) -> Option<ApiActiveInputRecovery> {
        match self {
            Self::LocalQueue(_) => None,
            Self::Api(source) => Some(ApiActiveInputRecovery {
                api: source.api.clone(),
                run_id: source.run_id,
                sandbox_token: source.sandbox_token.clone(),
            }),
        }
    }

    pub(crate) async fn read(&mut self, min_sequence: u64) -> RunnerResult<ActiveInputBatch> {
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
                    crate::error::RunnerError::Internal(format!(
                        "active-input reader task failed: {error}"
                    ))
                })?;
                Ok(ActiveInputBatch::Local(entries))
            }
            Self::Api(source) => read_api_active_input(source).await,
        }
    }

    pub(crate) async fn wait_until_next_read(&mut self) {
        match self {
            Self::LocalQueue(_) => tokio::time::sleep(LOCAL_ACTIVE_INPUT_POLL_INTERVAL).await,
            Self::Api(source) => {
                tokio::select! {
                    () = source.notifications.wait() => {}
                    () = tokio::time::sleep(API_ACTIVE_INPUT_RECHECK_INTERVAL) => {}
                }
            }
        }
    }

    /// Back off failed API reads independently of local polling and Guest control.
    /// The base doubles from 250 ms to 4 s; run/attempt jitter uses 80%-100% of
    /// that base to spread shared-outage retries without exceeding the cap.
    /// Notifications do not bypass this delay; the caller owns cancellation.
    pub(crate) async fn wait_after_read_error(&self) {
        let delay = match self {
            Self::LocalQueue(_) => LOCAL_ACTIVE_INPUT_POLL_INTERVAL,
            Self::Api(source) => {
                let exponent = source.consecutive_read_failures.saturating_sub(1).min(4);
                let base = API_ACTIVE_INPUT_RETRY_INITIAL_INTERVAL
                    .saturating_mul(1_u32 << exponent)
                    .min(API_ACTIVE_INPUT_RETRY_MAX_INTERVAL);
                let mut hasher = DefaultHasher::new();
                source.run_id.hash(&mut hasher);
                source.consecutive_read_failures.hash(&mut hasher);
                let jitter_per_mille = 800 + hasher.finish() % 201;
                let delay =
                    Duration::from_millis(base.as_millis() as u64 * jitter_per_mille / 1_000);
                tracing::info!(
                    run_id = %source.run_id,
                    consecutive_failures = source.consecutive_read_failures,
                    retry_delay_ms = delay.as_millis() as u64,
                    "active-input API read retry scheduled"
                );
                delay
            }
        };
        tokio::time::sleep(delay).await;
    }
}

impl ApiActiveInputRecovery {
    pub(crate) async fn record_delivery(
        &self,
        delivery_id: &str,
    ) -> RunnerResult<ActiveInputReceiptResponse> {
        self.api
            .record_active_input_delivery(self.run_id, &self.sandbox_token, delivery_id)
            .await
    }
}

async fn read_api_active_input(
    source: &mut ApiActiveInputSource,
) -> RunnerResult<ActiveInputBatch> {
    let response = source
        .api
        .reserve_active_inputs(source.run_id, &source.sandbox_token)
        .await;
    source.consecutive_read_failures = if response.is_ok() {
        0
    } else {
        source.consecutive_read_failures.saturating_add(1)
    };
    response.map(ActiveInputBatch::Api)
}
