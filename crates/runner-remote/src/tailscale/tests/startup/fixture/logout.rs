//! Controlled logout replies on the same external TLS/Noise/HTTP2 service.

use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

use bytes::Bytes;
use http_body_util::Full;
use hyper::Response;
use tokio_util::sync::CancellationToken;

pub(in crate::tailscale::tests) struct Service {
    pub(in crate::tailscale::tests) requests: Mutex<Vec<serde_json::Value>>,
    pub(in crate::tailscale::tests) requested: tokio::sync::Notify,
    pub(in crate::tailscale::tests) blocked: AtomicBool,
    pub(in crate::tailscale::tests) response: CancellationToken,
    pub(in crate::tailscale::tests) status: Mutex<hyper::StatusCode>,
    pub(in crate::tailscale::tests) body: Mutex<Vec<u8>>,
}

impl Service {
    pub(super) fn new() -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            requested: tokio::sync::Notify::new(),
            blocked: AtomicBool::new(false),
            response: CancellationToken::new(),
            status: Mutex::new(hyper::StatusCode::OK),
            body: Mutex::new(b"{}".to_vec()),
        }
    }

    pub(super) async fn reply(
        &self,
        request: serde_json::Value,
        node_key: String,
        hostinfo: serde_json::Value,
    ) -> Response<Full<Bytes>> {
        assert_eq!(request["NodeKey"], node_key);
        assert_eq!(request["Hostinfo"], hostinfo);
        assert_eq!(request["Expiry"], "1970-01-01T00:02:03Z");
        assert_eq!(request["Ephemeral"], true);
        assert!(request.get("Auth").is_none());
        assert!(request.get("Followup").is_none());
        self.requests.lock().unwrap().push(request);
        self.requested.notify_one();
        if self.blocked.load(Ordering::Acquire) {
            self.response.cancelled().await;
        }
        Response::builder()
            .status(*self.status.lock().unwrap())
            .body(Full::new(Bytes::from(self.body.lock().unwrap().clone())))
            .unwrap()
    }
}
