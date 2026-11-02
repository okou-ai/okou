use super::*;
use crate::error::ProviderError;
use crate::http::{ApiRequestBuilder, ClientHeaders};
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer};
use tracing::instrument::WithSubscriber;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

fn builder(client: reqwest::Client, url: String) -> ApiRequestBuilder {
    ApiRequestBuilder {
        diagnostics: crate::http::TransportDiagnostics::new(),
        builder: client.post(url).bearer_auth("private-test-token"),
        client,
        client_headers: ClientHeaders::new("observed-session".into(), "1.2.3").unwrap(),
        query: Vec::new(),
    }
}

fn summary(events: &CapturedEvents) -> CapturedEvent {
    let mut entries = events.entries().into_iter().filter(|event| {
        event.fields.get("message").map(String::as_str) == Some("claim transport completed")
    });
    let summary = entries.next().expect("claim transport summary");
    assert!(entries.next().is_none(), "one frozen summary per attempt");
    summary
}

#[derive(Clone)]
struct FailedSystemLookup;

impl Service<HyperName> for FailedSystemLookup {
    type Response = std::vec::IntoIter<SocketAddr>;
    type Error = std::io::Error;
    type Future = std::future::Ready<Result<Self::Response, Self::Error>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, _: HyperName) -> Self::Future {
        std::future::ready(Err(std::io::Error::other("private resolver failure")))
    }
}

#[tokio::test]
async fn dns_failure_keeps_request_identity_error_and_phase_outcomes() {
    // Only the external system resolver result is substituted. The real
    // reqwest connector, error path, finalized headers and observed send run.
    let client = reqwest::Client::builder()
        .dns_resolver(TimedResolver(FailedSystemLookup))
        .connector_layer(ConnectionTimingLayer)
        .build()
        .unwrap();
    let prepared = builder(client, "http://localhost:9/claim?private=query".into())
        .prepare("claim")
        .unwrap();
    let context = prepared.context().clone();
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let result = prepared
        .send_observed_claim(RunId::new_v4(), Instant::now())
        .with_subscriber(subscriber)
        .await;
    assert!(matches!(result, Err(ProviderError::ApiTransport(ref error))
        if error.failure_kind == crate::error::ApiFailureKind::Connect));
    let event = summary(&captured);
    assert_eq!(event.fields["client_request_id"], context.client_request_id);
    assert_eq!(event.fields["dns_started"], "1");
    assert_eq!(event.fields["dns_failed"], "1");
    assert_eq!(event.fields["connect_failed"], "1");
    assert!(event.fields.contains_key("dns_terminal_duration_ms"));
    assert_eq!(event.fields["outcome"], "request_failed");
    let records = format!("{:?}", captured.entries());
    for secret in [
        "private-test-token",
        "private=query",
        "private resolver failure",
        "http://localhost",
    ] {
        assert!(
            !records.contains(secret),
            "transport diagnostics leaked {secret}"
        );
    }
}

#[tokio::test]
async fn observed_request_preserves_json_headers_query_and_timeout_override() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitForDisconnect]).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .connector_layer(ConnectionTimingLayer)
        .build()
        .unwrap();
    let payload = serde_json::json!({"text": "private body / \"quoted\"", "number": 7});
    let prepared = builder(client, format!("{}/claim?cursor=a%2Fb", server.url()))
        .json(&payload)
        .timeout(Duration::from_secs(1))
        .prepare("claim")
        .unwrap();
    let context = prepared.context().clone();
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let pending = tokio::spawn(
        async move {
            prepared
                .send_observed_claim(RunId::new_v4(), Instant::now())
                .await
        }
        .with_subscriber(subscriber),
    );
    let request = server
        .next_request("observed request with timeout override")
        .await;
    assert!(request.starts_with("POST /claim?cursor=a%2Fb HTTP/1.1\r\n"));
    let (headers, body) = request.split_once("\r\n\r\n").unwrap();
    assert_eq!(body.as_bytes(), serde_json::to_vec(&payload).unwrap());
    assert!(headers.contains(&context.client_request_id));
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("authorization: bearer private-test-token")
    );
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("content-type: application/json")
    );
    // The peer never responds. Finishing before the default ten-second budget
    // proves observed send retains the actual per-request timeout override.
    let result = tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(result, Err(ProviderError::ApiTransport(ref error))
        if error.failure_kind == crate::error::ApiFailureKind::Timeout));
    server.assert_finished().await;
    let event = summary(&captured);
    assert_eq!(event.fields["outcome"], "request_failed");
    assert_eq!(event.fields["connect_succeeded"], "1");
    let entries = captured.entries();
    let diagnostic = entries
        .iter()
        .find(|e| {
            e.fields.get("message").map(String::as_str) == Some("API transport failure diagnostics")
        })
        .unwrap();
    assert_eq!(diagnostic.fields["socket_metadata_available"], "false");
    assert!(!diagnostic.fields.contains_key("connection_id"));
    assert!(!format!("{:?}", captured.entries()).contains("private body"));
}

#[tokio::test]
async fn speculative_connector_completion_cannot_change_a_frozen_attempt() {
    // Exercise the production Layer against a controlled external connector:
    // a pool checkout may finish a request while this connector remains alive.
    #[derive(Clone)]
    struct GatedConnector(Arc<tokio::sync::Notify>);
    impl Service<()> for GatedConnector {
        type Response = ();
        type Error = std::convert::Infallible;
        type Future = BoxFuture<'static, Result<(), Self::Error>>;
        fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
        fn call(&mut self, _: ()) -> Self::Future {
            let gate = Arc::clone(&self.0);
            async move {
                gate.notified().await;
                Ok(())
            }
            .boxed()
        }
    }
    let prepared = builder(reqwest::Client::new(), "http://localhost/claim".into())
        .prepare("claim")
        .unwrap();
    let captured = CapturedEvents::default();
    let dispatch = Dispatch::new(tracing_subscriber::registry().with(captured.clone()));
    let observer = tracing::dispatcher::with_default(&dispatch, || {
        Observer::new(Instant::now(), RunId::new_v4(), prepared.context().clone())
    });
    let observation = ClaimObservation {
        observer: observer.clone(),
        outcome: "response_headers",
    };
    let gate = Arc::new(tokio::sync::Notify::new());
    let mut connector = ConnectionTimingLayer.layer(GatedConnector(Arc::clone(&gate)));
    let connecting = CURRENT.sync_scope(observer.clone(), || connector.call(()));
    let before = {
        let state = observer.state();
        assert_eq!(state.connect.started, 1);
        assert_eq!(state.connect.active, 1);
        state.connect
    };
    drop(observation);
    let records_at_end = captured.entries().len();
    assert_eq!(summary(&captured).fields["connect_active_at_end"], "1");
    gate.notify_one();
    connecting.await.unwrap();
    let after = observer.state().connect;
    assert_eq!(before.started, after.started);
    assert_eq!(before.active, after.active);
    assert_eq!(before.succeeded, after.succeeded);
    assert_eq!(before.terminal_ms, after.terminal_ms);
    assert_eq!(
        captured.entries().len(),
        records_at_end,
        "completed request cannot emit late connector records"
    );
}

#[tokio::test]
async fn connector_records_are_capped_and_dropped_futures_settle_once() {
    #[derive(Clone)]
    struct Connector(bool);
    impl Service<()> for Connector {
        type Response = ();
        type Error = std::convert::Infallible;
        type Future = BoxFuture<'static, Result<(), Self::Error>>;
        fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
        fn call(&mut self, _: ()) -> Self::Future {
            if self.0 {
                async { Ok(()) }.boxed()
            } else {
                std::future::pending().boxed()
            }
        }
    }
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    async {
        let prepared = builder(reqwest::Client::new(), "http://localhost/claim".into())
            .prepare("claim")
            .unwrap();
        let observer = Observer::new(Instant::now(), RunId::new_v4(), prepared.context().clone());
        let summary = ClaimObservation {
            observer: observer.clone(),
            outcome: "response_headers",
        };
        observer
            .scope(async {
                let mut connector = ConnectionTimingLayer.layer(Connector(true));
                for _ in 0..MAX_PHASE_RECORDS + 2 {
                    connector.call(()).await.unwrap();
                }
                let mut pending = ConnectionTimingLayer.layer(Connector(false));
                drop(pending.call(()));
            })
            .await;
        drop(summary);
    }
    .with_subscriber(subscriber)
    .await;
    let event = summary(&captured);
    assert_eq!(event.fields["connect_started"], "7");
    assert_eq!(event.fields["connect_succeeded"], "6");
    assert_eq!(event.fields["connect_dropped"], "1");
    assert_eq!(event.fields["connect_active_at_end"], "0");
    assert_eq!(event.fields["phase_records_truncated"], "true");
    assert_eq!(
        captured
            .entries()
            .iter()
            .filter(|event| event.fields.get("message").map(String::as_str)
                == Some("claim transport phase"))
            .count(),
        (MAX_PHASE_RECORDS * 2) as usize
    );
}
