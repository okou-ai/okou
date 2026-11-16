//! Host ingress with startup-only public reachability validation.
//! Caddy's runtime availability never acquires or cancels Run ownership.
//! Health and complete-input dispatch share service authentication. Sandbox
//! paths stay reserved. Caddy terminates TLS and preserves the original URI.

pub(crate) mod dispatch;

use std::convert::Infallible;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use runner_host::runner_ingress_socket::RunnerIngressSocket;
use runner_host::runner_process_identity::RunnerProcessIdentity;
use subtle::ConstantTimeEq;
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

const MAX_CONNECTIONS: usize = 32;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HEALTH_RESPONSE_BYTES: usize = 2;

/// Required only for official, non-local Runner startup.
pub struct IngressConfig {
    pub directory: PathBuf,
    pub hostname: String,
    pub token: String,
}

struct IngressHandler {
    identity: RunnerProcessIdentity,
    hostname: String,
    token: String,
    dispatch: OnceLock<dispatch::DispatchIntake>,
}

impl IngressHandler {
    fn new(identity: RunnerProcessIdentity, hostname: String, token: &str) -> Self {
        Self {
            identity,
            hostname,
            token: token.to_owned(),
            dispatch: OnceLock::new(),
        }
    }

    async fn check_public(&self) -> io::Result<()> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(HEALTH_TIMEOUT)
            .build()
            .map_err(io::Error::other)?;
        self.check(&client, &self.url()).await
    }

    fn url(&self) -> String {
        format!(
            "https://{}/runners/{}/control/health",
            self.hostname,
            self.identity.runner_id()
        )
    }

    async fn check(&self, client: &reqwest::Client, url: &str) -> io::Result<()> {
        let mut response = client
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(io::Error::other)?;
        if response.status() != StatusCode::OK {
            return Err(io::Error::other(format!(
                "public Runner health returned {}",
                response.status()
            )));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(io::Error::other)? {
            if body.len().saturating_add(chunk.len()) > MAX_HEALTH_RESPONSE_BYTES {
                return Err(io::Error::other(
                    "public Runner health response is too large",
                ));
            }
            body.extend_from_slice(&chunk);
        }
        if body != b"ok" {
            return Err(io::Error::other("public Runner health did not return ok"));
        }
        Ok(())
    }

    async fn handle(&self, mut request: Request<Incoming>) -> Response<Full<Bytes>> {
        let path = format!("/runners/{}/control/health", self.identity.runner_id());
        let dispatch_run = request
            .uri()
            .path()
            .strip_prefix(&format!(
                "/runners/{}/control/runs/",
                self.identity.runner_id()
            ))
            .and_then(|path| path.strip_suffix("/dispatch"))
            .and_then(|run| {
                run.parse::<runner_types::ids::RunId>()
                    .ok()
                    .filter(|id| id.to_string() == run)
            });
        // Hyper keeps the raw URI: no decoding/rewriting may turn a reserved
        // sandbox path, traversal or encoded separator into a control request.
        if (request.uri().path() != path && dispatch_run.is_none())
            || request.uri().query().is_some()
        {
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
            .and_then(|v| v.strip_prefix("Bearer "));
        if request.headers().get_all("authorization").iter().count() != 1
            || !credential.is_some_and(|credential| {
                bool::from(credential.as_bytes().ct_eq(self.token.as_bytes()))
            })
        {
            return response(StatusCode::UNAUTHORIZED, "");
        }
        if let Some(run_id) = dispatch_run {
            if request.method() != Method::POST {
                return response(StatusCode::METHOD_NOT_ALLOWED, "");
            }
            if request.headers().contains_key("upgrade")
                || request.headers().contains_key("content-encoding")
                || request
                    .headers()
                    .get("content-type")
                    .is_none_or(|v| v != "application/json")
            {
                return response(StatusCode::BAD_REQUEST, "");
            }
            if request
                .headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .is_some_and(|length| length > dispatch::MAX_BODY as u64)
            {
                return response(StatusCode::PAYLOAD_TOO_LARGE, "");
            }
            let Some(intake) = self.dispatch.get() else {
                return self.dispatch_response(run_id, dispatch::Disposition::Unknown);
            };
            let Some(permit) = intake.try_reserve() else {
                let mut result = self.dispatch_response(run_id, dispatch::Disposition::Busy);
                *result.status_mut() = StatusCode::TOO_MANY_REQUESTS;
                return result;
            };
            let read = async {
                let mut bytes = Vec::new();
                while let Some(frame) = request.body_mut().frame().await {
                    let frame = frame.map_err(|_| StatusCode::BAD_REQUEST)?;
                    if let Ok(data) = frame.into_data() {
                        if bytes.len().saturating_add(data.len()) > dispatch::MAX_BODY {
                            return Err(StatusCode::PAYLOAD_TOO_LARGE);
                        }
                        bytes.extend_from_slice(&data);
                    } else {
                        return Err(StatusCode::BAD_REQUEST);
                    }
                }
                Ok(bytes)
            };
            let bytes = match tokio::time::timeout(Duration::from_secs(5), read).await {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(status)) => return response(status, ""),
                Err(_) => return response(StatusCode::REQUEST_TIMEOUT, ""),
            };
            let verdict = intake
                .submit(self.identity, run_id, &bytes, permit, dispatch::now_ms())
                .await;
            return self.dispatch_response(run_id, verdict);
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
        response(StatusCode::OK, "ok")
    }

    fn dispatch_response(
        &self,
        run_id: runner_types::ids::RunId,
        disposition: dispatch::Disposition,
    ) -> Response<Full<Bytes>> {
        let body = serde_json::json!({
            "runnerId": self.identity.runner_id(),
            "heartbeatGeneration": self.identity.heartbeat_generation(),
            "runId": run_id,
            "disposition": disposition,
        })
        .to_string();
        let mut result = response(StatusCode::OK, &body);
        result.headers_mut().insert(
            "content-type",
            hyper::header::HeaderValue::from_static("application/json"),
        );
        result.headers_mut().insert(
            "cache-control",
            hyper::header::HeaderValue::from_static("no-store"),
        );
        result
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
        hyper::header::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    result
}

/// Owned by startup and then the running reactor, independently of Caddy.
pub struct IngressRuntime {
    handler: Arc<IngressHandler>,
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl IngressRuntime {
    pub async fn start(
        directory: PathBuf,
        identity: RunnerProcessIdentity,
        hostname: String,
        token: &str,
    ) -> io::Result<Self> {
        if !canonical_hostname(&hostname) || token.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Runner ingress requires a canonical public hostname and service credential",
            ));
        }
        let handler = Arc::new(IngressHandler::new(identity, hostname, token));
        let socket = tokio::task::spawn_blocking(move || {
            RunnerIngressSocket::bind(&directory, identity.runner_id())
        })
        .await
        .map_err(io::Error::other)??;
        let mut runtime = Self {
            handler: handler.clone(),
            cancel: CancellationToken::new(),
            task: None,
        };
        let cancel = runtime.cancel.clone();
        runtime.task = Some(tokio::spawn(async move {
            let mut connections = JoinSet::new();
            let mut expiry_tick = tokio::time::interval(Duration::from_secs(1));
            expiry_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => break,
                    _ = expiry_tick.tick() => {
                        if let Some(intake) = handler.dispatch.get() {
                            intake.expire(dispatch::now_ms());
                        }
                    },
                    Some(_) = connections.join_next(), if !connections.is_empty() => {},
                    accepted = socket.accept() => {
                        let stream = match accepted {
                            Ok(stream) => stream,
                            Err(error) => { tracing::warn!(%error, "Runner ingress accept failed"); break; }
                        };
                        if connections.len() >= MAX_CONNECTIONS { continue; }
                        let handler = handler.clone();
                        connections.spawn(async move {
                            let service = service_fn(move |request| {
                                let handler = handler.clone();
                                async move { Ok::<_, Infallible>(handler.handle(request).await) }
                            });
                            // Bounded HTTP requests; the same transport
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
        Ok(runtime)
    }

    /// Called once before the first Running publication, never as a watchdog.
    pub async fn check_public_health(&self) -> io::Result<()> {
        self.handler.check_public().await
    }

    pub(crate) fn enable_dispatch(&self, intake: dispatch::DispatchIntake) {
        assert!(
            self.handler.dispatch.set(intake).is_ok(),
            "dispatch intake configured once"
        );
    }

    #[cfg(test)]
    pub(crate) async fn check_public_health_with_client(
        &self,
        client: &reqwest::Client,
    ) -> io::Result<()> {
        self.handler.check(client, &self.handler.url()).await
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

#[cfg(test)]
pub(crate) mod test_support;
