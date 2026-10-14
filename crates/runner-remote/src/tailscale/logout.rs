//! One bounded self-logout on the retained, authenticated control connection.

use std::time::Duration;

use bytes::Bytes;
use serde::{
    Deserialize,
    de::{MapAccess, Visitor, value::MapAccessDeserializer},
};
use ts_control_serde::RegisterRequest;
use ts_http_util::{BytesBody, ClientExt, HeaderName, HeaderValue, Http2, ResponseExt};

use super::{Failure, control_io::collect};

const TIMEOUT: Duration = Duration::from_secs(2);
const RESPONSE_BYTES: usize = 64 * 1024;

pub(super) struct Logout {
    client: Http2<BytesBody>,
    url: reqwest::Url,
    header: (HeaderName, HeaderValue),
    body: Bytes,
}

impl Logout {
    pub(super) fn new(
        client: Http2<BytesBody>,
        url: reqwest::Url,
        header: (HeaderName, HeaderValue),
        request: &RegisterRequest<'_>,
    ) -> Result<Self, Failure> {
        let body = serde_json::to_vec(request).map_err(|_| Failure::DomainFailed)?;
        Ok(Self {
            client,
            url,
            header,
            body: Bytes::from(body),
        })
    }

    pub(super) async fn run(self) {
        // The physical worker owns this client until the attempt finishes. A
        // lost response is not replayed; ephemeral-node GC remains the fallback.
        let reason = match tokio::time::timeout(TIMEOUT, self.request()).await {
            Ok(Ok(())) => "confirmed",
            Ok(Err(_)) => "unconfirmed",
            Err(_) => "timed_out",
        };
        if reason == "confirmed" {
            tracing::info!(target: "runner_remote::tailscale", stage = "logout", reason, "native Tailscale node logout");
        } else {
            tracing::warn!(target: "runner_remote::tailscale", stage = "logout", reason, "native Tailscale node logout");
        }
    }

    async fn request(self) -> Result<(), Failure> {
        let response = self
            .client
            .post(&self.url, [self.header], self.body.into())
            .await
            .map_err(|_| Failure::DomainFailed)?;
        if response.status() != ts_http_util::StatusCode::OK {
            return Err(Failure::DomainFailed);
        }
        let body = collect(response.into_read(), RESPONSE_BYTES).await?;
        // A logout response can omit login/user fields and report an expired
        // key. Never follow an interactive login URL or expose a server error.
        #[derive(Deserialize)]
        #[serde(rename_all = "PascalCase")]
        struct Reply<'a> {
            #[serde(default, borrow)]
            error: &'a str,
            #[serde(default, borrow, rename = "AuthURL")]
            auth_url: &'a str,
        }
        // Serde's struct visitor also accepts arrays. Require the provider's
        // object envelope before applying its optional outcome-field defaults.
        struct ReplyObject;
        impl<'de> Visitor<'de> for ReplyObject {
            type Value = Reply<'de>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a Tailscale logout reply object")
            }

            fn visit_map<M: MapAccess<'de>>(self, map: M) -> Result<Self::Value, M::Error> {
                Reply::deserialize(MapAccessDeserializer::new(map))
            }
        }
        let mut parser = serde_json::Deserializer::from_slice(&body);
        let reply = serde::Deserializer::deserialize_map(&mut parser, ReplyObject)
            .map_err(|_| Failure::DomainFailed)?;
        parser.end().map_err(|_| Failure::DomainFailed)?;
        if !reply.error.is_empty() || !reply.auth_url.is_empty() {
            return Err(Failure::DomainFailed);
        }
        Ok(())
    }
}
