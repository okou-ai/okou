#[cfg(test)]
mod tests {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use guest_channel_server::{
        Diagnostics, Error, EventError, Notice, Operation, Params, Peer, Service, ServiceFuture,
        serve,
    };
    use guest_contracts::sandbox_channel::{Categories, decode_message};
    use serde_json::{Value, json};
    use std::{
        io,
        sync::{Arc, Mutex},
        time::Duration,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt, DuplexStream},
        task::JoinHandle,
        time::timeout,
    };

    const WAIT: Duration = Duration::from_secs(3);
    fn id(n: u64) -> String {
        format!("00000000-0000-4000-8000-{n:012x}")
    }
    fn request(n: u64, operation: &str, payload: &str) -> Value {
        json!({"schemaVersion":1,"type":"request","id":id(n),"category":"diagnostics","categoryVersion":1,"operation":operation,"params":{"payload":payload}})
    }
    fn notice(n: u64, message: &str) -> Value {
        json!({"schemaVersion":1,"type":"event","id":id(n),"category":"diagnostics","categoryVersion":1,"event":"notice","data":{"message":message}})
    }
    struct Fixture {
        client: DuplexStream,
        server: Option<JoinHandle<io::Result<()>>>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Some(server) = &self.server {
                server.abort();
            }
        }
    }
    impl Fixture {
        async fn start(service: Arc<dyn Service>, capacity: usize) -> Self {
            let (mut client, guest) = tokio::io::duplex(capacity);
            let server = tokio::spawn(serve(guest, service));
            let mut activated = [0];
            timeout(WAIT, client.read_exact(&mut activated))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(activated, [guest_contracts::private_duplex::ACTIVATED]);
            Self {
                client,
                server: Some(server),
            }
        }
        async fn new(service: Arc<dyn Service>) -> Self {
            let mut fixture = Self::start(service, 65536).await;
            fixture.hello().await;
            fixture
        }
        async fn hello(&mut self) {
            self.send(
                json!({"schemaVersion":1,"type":"hello","id":id(1),"categories":{"diagnostics":1}}),
            )
            .await;
            let reply = self.recv().await;
            assert_eq!(reply["type"], "response");
            assert_eq!(reply["requestId"], id(1));
            assert_ne!(reply["id"], id(1));
            assert_eq!(reply["result"], json!({"categories":{"diagnostics":1}}));
            let first_business = self.recv().await;
            assert_eq!(first_business["type"], "event");
            assert_eq!(first_business["event"], "notice");
            assert_eq!(first_business["data"], json!({"message":"ready"}));
        }
        async fn send(&mut self, value: Value) {
            self.raw(&serde_json::to_vec(&value).unwrap()).await;
        }
        async fn raw(&mut self, bytes: &[u8]) {
            timeout(WAIT, async {
                self.client
                    .write_all(&(bytes.len() as u32).to_be_bytes())
                    .await?;
                self.client.write_all(bytes).await
            })
            .await
            .unwrap()
            .unwrap();
        }
        async fn recv(&mut self) -> Value {
            timeout(WAIT, async {
                let mut header = [0; 4];
                self.client.read_exact(&mut header).await.unwrap();
                let size = u32::from_be_bytes(header) as usize;
                assert!(size <= 65536);
                let mut bytes = vec![0; size];
                self.client.read_exact(&mut bytes).await.unwrap();
                decode_message(&bytes).unwrap();
                serde_json::from_slice(&bytes).unwrap()
            })
            .await
            .unwrap()
        }
        async fn reply(&mut self, n: u64, request_id: &str, result: Value) {
            self.send(json!({"schemaVersion":1,"type":"response","id":id(n),"requestId":request_id,"result":result})).await;
        }
        async fn healthy(&mut self, n: u64) {
            self.send(request(n, "echo", "dXNlZnVs")).await;
            let reply = self.recv().await;
            assert_eq!(reply["requestId"], id(n));
            assert_eq!(reply["result"], json!({"payload":"dXNlZnVs"}));
            assert!(reply.get("error").is_none());
        }
        async fn close(mut self) {
            self.client.shutdown().await.unwrap();
            let mut end = [0];
            assert_eq!(
                timeout(WAIT, self.client.read(&mut end))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
            timeout(WAIT, self.server.take().unwrap())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        }
        async fn fatal(mut self) {
            assert!(
                timeout(WAIT, self.server.take().unwrap())
                    .await
                    .unwrap()
                    .unwrap()
                    .is_err()
            );
            assert_eq!(self.client.read(&mut [0]).await.unwrap(), 0);
        }
    }

    #[tokio::test]
    async fn simultaneous_nested_calls_keep_response_routing_and_separate_ids_live() {
        let mut f = Fixture::new(Arc::new(Diagnostics)).await;
        f.send(request(2, "peer.echo", "b3duZWQ=")).await;
        let reverse = f.recv().await;
        assert_eq!(reverse["operation"], "echo");
        let reverse_id = reverse["id"].as_str().unwrap();
        // A peer-origin request may deliberately use the outgoing request ID. It
        // belongs to a different identity map and cannot collide or settle that call.
        let mut equal = request(3, "echo", "c2VwYXJhdGU=");
        equal["id"] = Value::String(reverse_id.to_owned());
        f.send(equal).await;
        let other = f.recv().await;
        assert_eq!(other["requestId"], reverse_id);
        assert_eq!(other["result"]["payload"], "c2VwYXJhdGU=");
        // response.id alone cannot settle the reverse wait.
        f.send(json!({"schemaVersion":1,"type":"response","id":reverse_id,"requestId":id(999),"result":{"payload":""}})).await;
        f.reply(100, reverse_id, reverse["params"].clone()).await;
        let result = f.recv().await;
        assert_eq!(result["requestId"], id(2));
        assert_eq!(result["result"]["payload"], "b3duZWQ=");
        // Duplicate/late results are ignored, then a fresh call still works.
        f.reply(101, reverse_id, json!({"payload":""})).await;
        f.healthy(4).await;
        f.close().await;
    }

    #[tokio::test]
    async fn saturated_reverse_waits_return_busy_and_unwind_in_any_response_order() {
        let mut f = Fixture::new(Arc::new(Diagnostics)).await;
        for n in 2..10 {
            f.send(request(n, "peer.echo", "")).await;
        }
        let mut reverse = Vec::new();
        for _ in 0..8 {
            reverse.push(f.recv().await);
        }
        f.send(request(10, "echo", "")).await;
        let busy = f.recv().await;
        assert_eq!(busy["requestId"], id(10));
        assert_eq!(busy["error"]["code"], "busy");
        let mut completed = std::collections::BTreeSet::new();
        for (index, call) in reverse.into_iter().rev().enumerate() {
            f.reply(
                100 + index as u64,
                call["id"].as_str().unwrap(),
                call["params"].clone(),
            )
            .await;
            let reply = f.recv().await;
            assert!(reply.get("error").is_none());
            assert!(completed.insert(reply["requestId"].as_str().unwrap().to_owned()));
        }
        assert_eq!(completed, (2..10).map(id).collect());
        f.healthy(11).await;
        f.close().await;
    }

    #[tokio::test]
    async fn malformed_correlated_result_and_unknown_remote_error_are_call_local() {
        let mut f = Fixture::new(Arc::new(Diagnostics)).await;
        for (n, invalid) in [(2, true), (3, false)] {
            f.send(request(n, "peer.echo", "")).await;
            let reverse = f.recv().await;
            if invalid {
                f.reply(
                    100 + n,
                    reverse["id"].as_str().unwrap(),
                    json!({"payload":"not base64"}),
                )
                .await;
            } else {
                f.send(json!({"schemaVersion":1,"type":"response","id":id(100+n),"requestId":reverse["id"],"error":{"code":"future_failure"}})).await;
            }
            let result = f.recv().await;
            assert_eq!(result["requestId"], id(n));
            assert_eq!(
                result["error"]["code"],
                if invalid {
                    "invalid_request"
                } else {
                    "unavailable"
                }
            );
            assert!(result.get("result").is_none());
            f.healthy(10 + n).await;
        }
        f.close().await;
    }

    struct FaultService {
        events: Mutex<Vec<EventError>>,
        panic_observer: bool,
    }
    impl Service for FaultService {
        fn categories(&self) -> Categories {
            Diagnostics.categories()
        }
        fn request(&self, op: Operation, params: Params, peer: Peer) -> ServiceFuture<Value> {
            if let Params::Echo(echo) = &params {
                if echo.payload == STANDARD.encode(b"panic") {
                    return Box::pin(async {
                        panic!("consumer exception");
                    });
                }
                if echo.payload == STANDARD.encode(b"invalid") {
                    return Box::pin(async { Ok(json!({"unexpected":"value"})) });
                }
            }
            Diagnostics.request(op, params, peer)
        }
        fn notice(&self, notice: Notice, peer: Peer) -> ServiceFuture<()> {
            Box::pin(async move {
                peer.notice(Notice {
                    message: "handler reached".into(),
                })?;
                if notice.message == "panic" {
                    panic!("event consumer exception");
                }
                Err(Error::Unavailable)
            })
        }
        fn event_error(&self, error: EventError) {
            self.events.lock().unwrap().push(error);
            if self.panic_observer {
                panic!("observer exception");
            }
        }
    }

    #[tokio::test]
    async fn handler_panics_and_invalid_results_emit_safe_errors_without_tearing_down() {
        let service = Arc::new(FaultService {
            events: Mutex::new(Vec::new()),
            panic_observer: false,
        });
        let mut f = Fixture::new(service).await;
        for (n, input) in [(2, b"panic".as_slice()), (3, b"invalid".as_slice())] {
            f.send(request(n, "echo", &STANDARD.encode(input))).await;
            let reply = f.recv().await;
            assert_eq!(reply["error"], json!({"code":"unavailable"}));
            assert_eq!(reply["requestId"], id(n));
            assert!(reply.get("result").is_none());
            f.healthy(n + 10).await;
        }
        f.close().await;
    }

    #[tokio::test]
    async fn notices_have_no_ack_and_invalid_payload_does_not_disable_calls() {
        let mut f = Fixture::new(Arc::new(Diagnostics)).await;
        for n in 2..10 {
            f.send(notice(n, "one-way")).await;
        }
        let mut invalid = notice(10, "private payload");
        invalid["data"] = json!({"message":"private payload","extra":"private"});
        f.send(invalid).await;
        // The next frame is the owned echo response, not an event ACK/error.
        f.healthy(11).await;
        f.close().await;
    }

    #[tokio::test]
    async fn event_failure_metadata_is_redacted_and_throwing_observer_is_retired() {
        let service = Arc::new(FaultService {
            events: Mutex::new(Vec::new()),
            panic_observer: true,
        });
        let mut f = Fixture::new(service.clone()).await;
        let mut invalid = notice(2, "private");
        invalid["data"] = json!({"message":"private","extra":"secret"});
        f.send(invalid).await;
        f.healthy(10).await;
        f.send(notice(3, "panic")).await;
        assert_eq!(f.recv().await["data"]["message"], "handler reached");
        f.healthy(11).await;
        let events = service.events.lock().unwrap().clone();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0],
            EventError {
                category: "diagnostics".into(),
                event: "notice".into(),
                error: guest_channel_server::ChannelError::InvalidParams.into()
            }
        );
        f.close().await;
    }

    #[tokio::test]
    async fn category_and_payload_rejection_does_not_execute_a_reverse_handler() {
        let mut f = Fixture::new(Arc::new(Diagnostics)).await;
        let mut missing = request(2, "peer.echo", "");
        missing["category"] = json!("fs");
        f.send(missing).await;
        assert_eq!(f.recv().await["error"]["code"], "unsupported_category");
        let mut mismatch = request(3, "peer.echo", "");
        mismatch["categoryVersion"] = json!(2);
        f.send(mismatch).await;
        assert_eq!(
            f.recv().await["error"],
            json!({"code":"category_version_mismatch","category":"diagnostics","expectedVersion":1,"receivedVersion":2})
        );
        f.send(request(4, "peer.echo", "invalid")).await;
        assert_eq!(f.recv().await["error"]["code"], "invalid_params");
        f.send(request(5, "unknown", "")).await;
        assert_eq!(f.recv().await["error"]["code"], "unknown_operation");
        f.healthy(6).await;
        f.close().await;
    }

    struct HeldEvents(tokio::sync::mpsc::UnboundedSender<EventError>);
    impl Service for HeldEvents {
        fn categories(&self) -> Categories {
            Diagnostics.categories()
        }
        fn request(
            &self,
            operation: Operation,
            params: Params,
            peer: Peer,
        ) -> ServiceFuture<Value> {
            Diagnostics.request(operation, params, peer)
        }
        fn notice(&self, _notice: Notice, peer: Peer) -> ServiceFuture<()> {
            Box::pin(async move {
                peer.echo(guest_channel_server::Echo {
                    payload: String::new(),
                })
                .await?;
                peer.notice(Notice {
                    message: "event work finished".into(),
                })
            })
        }
        fn event_error(&self, error: EventError) {
            self.0.send(error).unwrap();
        }
    }

    #[tokio::test]
    async fn event_saturation_is_local_and_capacity_returns_after_real_reverse_completion() {
        let (observations, mut observed) = tokio::sync::mpsc::unbounded_channel();
        let mut f = Fixture::new(Arc::new(HeldEvents(observations))).await;
        for n in 2..10 {
            f.send(notice(n, "hold")).await;
        }
        let mut reverse = Vec::new();
        for _ in 0..8 {
            let message = f.recv().await;
            assert_eq!(message["type"], "request");
            reverse.push(message);
        }
        f.send(notice(10, "ninth")).await;
        assert_eq!(
            timeout(WAIT, observed.recv()).await.unwrap().unwrap(),
            EventError {
                category: "diagnostics".into(),
                event: "notice".into(),
                error: Error::Busy
            }
        );
        f.send(request(11, "echo", "")).await;
        assert_eq!(f.recv().await["error"]["code"], "busy");
        for (n, call) in reverse.into_iter().enumerate() {
            f.reply(
                100 + n as u64,
                call["id"].as_str().unwrap(),
                call["params"].clone(),
            )
            .await;
            assert_eq!(f.recv().await["data"]["message"], "event work finished");
            if n == 0 {
                f.healthy(12).await;
            }
        }
        f.healthy(13).await;
        f.close().await;
    }

    #[tokio::test]
    async fn failing_event_handler_reports_bounded_metadata_and_releases_its_slot() {
        let service = Arc::new(FaultService {
            events: Mutex::new(Vec::new()),
            panic_observer: false,
        });
        let mut f = Fixture::new(service.clone()).await;
        for n in 2..11 {
            f.send(notice(n, "fail")).await;
            assert_eq!(f.recv().await["data"]["message"], "handler reached");
        }
        f.healthy(11).await;
        let events = service.events.lock().unwrap().clone();
        assert_eq!(events.len(), 9);
        assert!(events.iter().all(|error| *error
            == EventError {
                category: "diagnostics".into(),
                event: "notice".into(),
                error: Error::Unavailable
            }));
        f.close().await;
    }

    #[tokio::test]
    async fn an_active_inbound_id_collision_closes_and_cancels_nested_work() {
        let mut f = Fixture::new(Arc::new(Diagnostics)).await;
        f.send(request(2, "peer.echo", "")).await;
        assert_eq!(f.recv().await["type"], "request");
        f.send(request(2, "peer.echo", "")).await;
        f.fatal().await;
    }

    struct BurstEvents(tokio::sync::mpsc::UnboundedSender<EventError>);
    impl Service for BurstEvents {
        fn categories(&self) -> Categories {
            Diagnostics.categories()
        }
        fn request(
            &self,
            operation: Operation,
            params: Params,
            peer: Peer,
        ) -> ServiceFuture<Value> {
            Diagnostics.request(operation, params, peer)
        }
        fn notice(&self, _notice: Notice, peer: Peer) -> ServiceFuture<()> {
            Box::pin(async move {
                // A single service poll can produce a finite burst before IO
                // runs. The ninth producer must fail immediately, not wait.
                for _ in 0..9 {
                    peer.notice(Notice {
                        message: "n".repeat(256),
                    })?;
                }
                Ok(())
            })
        }
        fn event_error(&self, error: EventError) {
            self.0.send(error).unwrap();
        }
    }

    #[tokio::test]
    async fn writer_frame_pressure_is_local_and_recovers_after_physical_drain() {
        let (observations, mut observed) = tokio::sync::mpsc::unbounded_channel();
        let mut f = Fixture::start(Arc::new(BurstEvents(observations)), 256).await;
        f.hello().await;
        f.send(notice(2, "burst")).await;
        assert_eq!(
            timeout(WAIT, observed.recv()).await.unwrap().unwrap(),
            EventError {
                category: "diagnostics".into(),
                event: "notice".into(),
                error: Error::Busy
            }
        );
        for _ in 0..8 {
            let frame = f.recv().await;
            assert_eq!(frame["type"], "event");
            assert_eq!(frame["data"]["message"], "n".repeat(256));
        }
        f.healthy(3).await;
        f.close().await;
    }

    #[tokio::test]
    async fn partial_header_and_payload_remain_one_frame() {
        let mut f = Fixture::new(Arc::new(Diagnostics)).await;
        let bytes = serde_json::to_vec(&request(2, "echo", "")).unwrap();
        let header = (bytes.len() as u32).to_be_bytes();
        for byte in header {
            f.client.write_all(&[byte]).await.unwrap();
            tokio::task::yield_now().await;
        }
        for piece in bytes.chunks(3) {
            f.client.write_all(piece).await.unwrap();
            tokio::task::yield_now().await;
        }
        assert_eq!(f.recv().await["requestId"], id(2));
        f.close().await;
    }

    #[tokio::test]
    async fn invalid_bootstrap_and_common_identity_cannot_establish_readiness() {
        for value in [
            request(2, "echo", ""),
            json!({"schemaVersion":2,"type":"hello","id":id(1),"categories":{}}),
            json!({"schemaVersion":1,"type":"hello","id":"invalid","categories":{}}),
        ] {
            let mut f = Fixture::start(Arc::new(Diagnostics), 65536).await;
            f.send(value).await;
            f.fatal().await;
        }
        let mut f = Fixture::new(Arc::new(Diagnostics)).await;
        f.send(json!({"schemaVersion":1,"type":"response","id":id(2),"result":{}}))
            .await;
        f.fatal().await;
    }

    #[tokio::test]
    async fn hello_timeout_retires_the_initialized_stream() {
        let f = Fixture::start(Arc::new(Diagnostics), 65536).await;
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(5)).await;
        // The deadline, not EOF from the caller, causes retirement.
        let mut f = f;
        assert!(f.server.take().unwrap().await.unwrap().is_err());
        assert_eq!(f.client.read(&mut [0]).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn ordinary_reverse_deadline_is_local_and_releases_its_work_slot() {
        let mut f = Fixture::new(Arc::new(Diagnostics)).await;
        f.send(request(2, "peer.echo", "")).await;
        assert_eq!(f.recv().await["type"], "request");
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(10)).await;
        let reply = f.recv().await;
        assert_eq!(reply["requestId"], id(2));
        assert_eq!(reply["error"]["code"], "unavailable");
        tokio::time::resume();
        f.healthy(3).await;
        f.close().await;
    }

    #[tokio::test]
    async fn stalled_partial_writer_has_a_finite_deadline_and_closes_its_epoch() {
        let mut f = Fixture::start(Arc::new(Diagnostics), 256).await;
        f.hello().await;
        f.send(request(2, "echo", &STANDARD.encode(vec![1; 16384])))
            .await;
        // A length header is an externally observable write-start boundary. Leave
        // the large body unread so physical write completion cannot occur.
        let mut header = [0; 4];
        f.client.read_exact(&mut header).await.unwrap();
        assert!(u32::from_be_bytes(header) > 256);
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(15)).await;
        assert!(f.server.take().unwrap().await.unwrap().is_err());
        let mut trailing = Vec::new();
        f.client.read_to_end(&mut trailing).await.unwrap();
        assert!(trailing.len() < (u32::from_be_bytes(header) as usize));
    }
}
