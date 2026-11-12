//! Host ingress with startup-only public reachability validation.
//! Caddy's runtime availability never acquires or cancels Run ownership.
//! Only readonly health is implemented here; dispatch and sandbox paths remain
//! reserved. Caddy terminates TLS and preserves the identity-bearing URI.

use std::convert::Infallible;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Full;
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

struct Health {
    identity: RunnerProcessIdentity,
    hostname: String,
    token: String,
}

impl Health {
    fn new(identity: RunnerProcessIdentity, hostname: String, token: &str) -> Self {
        Self {
            identity,
            hostname,
            token: token.to_owned(),
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
            .and_then(|v| v.strip_prefix("Bearer "));
        if request.headers().get_all("authorization").iter().count() != 1
            || !credential.is_some_and(|credential| {
                bool::from(credential.as_bytes().ct_eq(self.token.as_bytes()))
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
        response(StatusCode::OK, "ok")
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
    health: Arc<Health>,
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
        let health = Arc::new(Health::new(identity, hostname, token));
        let socket = tokio::task::spawn_blocking(move || {
            RunnerIngressSocket::bind(&directory, identity.runner_id())
        })
        .await
        .map_err(io::Error::other)??;
        let mut runtime = Self {
            health: health.clone(),
            cancel: CancellationToken::new(),
            task: None,
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
                            Err(error) => { tracing::warn!(%error, "Runner ingress accept failed"); break; }
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
        Ok(runtime)
    }

    /// Called once before the first Running publication, never as a watchdog.
    pub async fn check_public_health(&self) -> io::Result<()> {
        self.health.check_public().await
    }

    #[cfg(test)]
    pub(crate) async fn check_public_health_with_client(
        &self,
        client: &reqwest::Client,
    ) -> io::Result<()> {
        self.health.check(client, &self.health.url()).await
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
