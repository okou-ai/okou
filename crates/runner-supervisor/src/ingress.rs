//! Optional host ingress. This owner never acquires or cancels Run ownership.
//! Only readonly health is implemented here; dispatch and sandbox paths remain
//! reserved. Caddy terminates TLS and preserves the identity-bearing URI.

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use hmac::{Hmac, KeyInit, Mac};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use runner_host::runner_ingress_socket::RunnerIngressSocket;
use runner_host::runner_process_identity::RunnerProcessIdentity;
use sha2::Sha256;
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

const MAX_CONNECTIONS: usize = 32;

struct Health {
    identity: RunnerProcessIdentity,
    hostname: String,
    authorization: Hmac<Sha256>,
}

impl Health {
    fn new(
        identity: RunnerProcessIdentity,
        hostname: String,
        token: &str,
    ) -> Result<Self, hmac::digest::InvalidLength> {
        let mut authorization = Hmac::<Sha256>::new_from_slice(token.as_bytes())?;
        authorization.update(
            format!(
                "okou-runner-ingress-health\n{}\n{}\n{}\n",
                identity.runner_id(),
                identity.heartbeat_generation(),
                hostname
            )
            .as_bytes(),
        );
        Ok(Self {
            identity,
            hostname,
            authorization,
        })
    }

    fn handle(&self, request: Request<Incoming>) -> Response<Full<Bytes>> {
        let path = format!("/runners/{}/control/health", self.identity.runner_id());
        // Hyper keeps the raw URI: no decoding/rewriting may turn a reserved
        // sandbox path, traversal or encoded separator into a control request.
        if request.uri().path() != path || request.uri().query().is_some() {
            return response(StatusCode::NOT_FOUND, "");
        }
        let host = request.headers().get("host").and_then(|v| v.to_str().ok());
        if request.headers().get_all("host").iter().count() != 1
            || !host.is_some_and(|host| {
                host == self.hostname || host == format!("{}:443", self.hostname)
            })
        {
            return response(StatusCode::NOT_FOUND, "");
        }
        let credential = request
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|v| v.len() == 64)
            .and_then(|v| hex::decode(v).ok());
        if request.headers().get_all("authorization").iter().count() != 1
            || !credential.is_some_and(|credential| {
                self.authorization.clone().verify_slice(&credential).is_ok()
            })
        {
            return response(StatusCode::UNAUTHORIZED, "");
        }
        if request.method() != Method::GET {
            return response(StatusCode::METHOD_NOT_ALLOWED, "");
        }
        if request.headers().contains_key("upgrade")
            || request.headers().contains_key("transfer-encoding")
            || request
                .headers()
                .get("content-length")
                .is_some_and(|v| v != "0")
        {
            return response(StatusCode::BAD_REQUEST, "");
        }
        response(
            StatusCode::OK,
            &serde_json::json!({
                "runnerId": self.identity.runner_id(),
                "heartbeatGeneration": self.identity.heartbeat_generation(),
            })
            .to_string(),
        )
    }
}

fn response(status: StatusCode, body: &str) -> Response<Full<Bytes>> {
    let mut result = Response::new(Full::new(Bytes::copy_from_slice(body.as_bytes())));
    *result.status_mut() = status;
    result.headers_mut().insert(
        "connection",
        hyper::header::HeaderValue::from_static("close"),
    );
    result.headers_mut().insert(
        "content-type",
        hyper::header::HeaderValue::from_static("application/json"),
    );
    result
}

/// Explicitly joined around Root's reactor call, including startup errors.
pub struct IngressRuntime {
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl IngressRuntime {
    pub async fn start(
        directory: PathBuf,
        identity: RunnerProcessIdentity,
        hostname: String,
        token: &str,
    ) -> Self {
        let mut runtime = Self {
            cancel: CancellationToken::new(),
            task: None,
        };
        if !canonical_hostname(&hostname) || token.is_empty() {
            tracing::warn!(
                "optional Runner ingress requires a canonical public hostname and service credential"
            );
            return runtime;
        }
        let bound = tokio::task::spawn_blocking(move || {
            RunnerIngressSocket::bind(&directory, identity.runner_id())
        })
        .await;
        let socket = match bound {
            Ok(Ok(socket)) => socket,
            Ok(Err(error)) => {
                tracing::warn!(%error, "optional Runner ingress unavailable");
                return runtime;
            }
            Err(error) => {
                tracing::warn!(%error, "optional Runner ingress bind task failed");
                return runtime;
            }
        };
        let health = match Health::new(identity, hostname, token) {
            Ok(health) => Arc::new(health),
            Err(error) => {
                tracing::warn!(%error, "optional ingress health credential unavailable");
                return runtime;
            }
        };
        let cancel = runtime.cancel.clone();
        runtime.task = Some(tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => break,
                    Some(_) = connections.join_next(), if !connections.is_empty() => {},
                    accepted = socket.accept() => {
                        let stream = match accepted {
                            Ok(stream) => stream,
                            Err(error) => { tracing::warn!(%error, "optional ingress accept failed"); break; }
                        };
                        if connections.len() >= MAX_CONNECTIONS { continue; }
                        let health = health.clone();
                        connections.spawn(async move {
                            let service = service_fn(move |request| {
                                let result = health.handle(request);
                                async move { Ok::<_, Infallible>(result) }
                            });
                            // Bounded readonly HTTP now; the same HTTP transport
                            // supports upgrades when a real application owns one.
                            let _ = http1::Builder::new()
                                .timer(TokioTimer::new())
                                .header_read_timeout(Duration::from_secs(5))
                                .max_buf_size(8192)
                                .keep_alive(false)
                                .serve_connection(TokioIo::new(stream), service)
                                .with_upgrades().await;
                        });
                    }
                }
            }
            connections.abort_all();
            while connections.join_next().await.is_some() {}
            drop(socket);
        }));
        runtime
    }

    pub async fn shutdown(mut self) {
        self.cancel.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for IngressRuntime {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

fn canonical_hostname(value: &str) -> bool {
    let labels: Vec<_> = value.split('.').collect();
    value.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                && label
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
        })
        && labels
            .last()
            .is_some_and(|label| label.as_bytes().first().is_some_and(u8::is_ascii_lowercase))
        && ![
            "localhost",
            "local",
            "internal",
            "home.arpa",
            "invalid",
            "test",
            "example",
        ]
        .iter()
        .any(|suffix| value == *suffix || value.ends_with(&format!(".{suffix}")))
}

#[cfg(test)]
mod tests;
