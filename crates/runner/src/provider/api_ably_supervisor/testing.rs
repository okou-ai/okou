//! Drive the production notification dispatcher without a live Ably service.

use super::*;

pub(crate) struct AblyTestEvents {
    config: SupervisorTaskConfig,
    subscription: Option<ably_subscriber::Subscription>,
    retry: RetryState<AblyConnectHandle>,
    disconnect: AblyDisconnectState,
    cancellations: FuturesUnordered<CancelDelivery>,
}

impl AblyTestEvents {
    pub(crate) fn new(http: crate::http::HttpClient, ssh: Arc<crate::ssh::SshRuntime>) -> Self {
        let api = ApiClient::new(http, "notification-test".into());
        Self {
            config: SupervisorTaskConfig {
                ssh: Some(ssh),
                connector_runtime_sync: ConnectorRuntimeSyncHandle::new(api.clone()),
                api,
                group: "notification-test".into(),
                profiles: vec![],
                poll_wakeups: Arc::new(PollWakeups::new(false)),
                direct_candidates: DirectCandidateInbox::new(8, Duration::from_secs(30)),
                cancel_tokens: RunCancellationRegistry::new(),
                active_input_notifications: ActiveInputNotifications::new(),
                provider_cancel: CancellationToken::new(),
                shutdown: CancellationToken::new(),
            },
            subscription: None,
            retry: RetryState::new(ABLY_BACKOFF_INITIAL, ABLY_BACKOFF_MAX, None),
            disconnect: AblyDisconnectState::disconnected("not subscribed".into()),
            cancellations: FuturesUnordered::new(),
        }
    }

    pub(crate) async fn send(&mut self, event: Option<ably_subscriber::Event>) {
        let connected = matches!(event, Some(ably_subscriber::Event::Connected));
        let message = matches!(event, Some(ably_subscriber::Event::Message(_)));
        handle_ably_event(
            &self.config,
            event,
            &mut self.subscription,
            &mut self.retry,
            &mut self.disconnect,
            &mut self.cancellations,
        )
        .await;
        if !message {
            // Connection health must still select job-discovery polling cadence.
            assert_eq!(
                self.config.poll_wakeups.snapshot().ably_connected,
                connected
            );
        }
    }
}
