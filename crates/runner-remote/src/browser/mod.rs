//! Window-scoped CDP using existing Runner authority and binary Guest RPC.

mod authority;
mod broker;
mod client;
mod policy;
#[cfg(test)]
mod tests;

use api_contracts::generated::constants::{
    browser::BROWSER_PROVIDER_TIMEOUT_MINUTES, runners::OFFICIAL_RUNNER_TOKEN_PREFIX,
};
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_provider::HttpClient;
use runner_rpc_proto::{
    Delivery, ErrorCode, Response,
    stream::{Frame, Reader, Writer, messages},
};
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};
use std::{sync::Arc, time::Duration};
use tokio::{
    sync::{Semaphore, mpsc},
    time::Instant,
};

use crate::{
    RemoteInitError,
    destination::{Network, PublicNetwork},
    guest_rpc,
};
use broker::Broker;

pub(super) const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_DURATION_MS: u64 = BROWSER_PROVIDER_TIMEOUT_MINUTES * 60 * 1000;
#[derive(Clone, Copy, Debug)]
pub(super) struct Failure;
type Result<T> = std::result::Result<T, Failure>;

pub struct BrowserRuntime {
    authority: authority::Authority,
    network: Arc<dyn Network>,
    tls: Arc<rustls::ClientConfig>,
    capacity: Arc<Semaphore>,
}

impl BrowserRuntime {
    pub fn official(
        http: HttpClient,
        token: &str,
        identity: RunnerProcessIdentity,
    ) -> std::result::Result<Option<Arc<Self>>, RemoteInitError> {
        if !token.starts_with(OFFICIAL_RUNNER_TOKEN_PREFIX) {
            return Ok(None);
        }
        Ok(Some(Arc::new(Self {
            authority: authority::Authority::new(http, token, identity)
                .map_err(|_| RemoteInitError::BrowserAuthority)?,
            network: Arc::new(PublicNetwork),
            tls: crate::tls::client_config().map_err(|_| RemoteInitError::BrowserAuthority)?,
            capacity: Arc::new(Semaphore::new(64)),
        })))
    }

    async fn refresh(&self, run: runner_types::ids::RunId, broker: &mut Broker) -> Result<()> {
        let mut current = self.authority.current(run, Some(&broker.scope)).await?;
        if current.expires > broker.scope.expires {
            // Re-read the existing provider boundary before accepting a longer
            // business lease. The original aggregate expiry is not a CDP ticket.
            let connection = self.authority.connection(run, &current).await?;
            current.expires = current.expires.min(connection.expires_at);
        }
        broker.scope = current;
        Ok(())
    }

    pub(crate) async fn dispatch(&self, args: guest_rpc::Request) {
        let guest_rpc::Request {
            input,
            lease,
            run,
            started,
            deadline,
            cancelled,
            sandbox_cancelled,
            request,
        } = args;
        let _lease = lease;
        let initial = guest_rpc::Scope {
            cancelled,
            sandbox_cancelled,
            deadline,
        };
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Empty {}
        let Some(remaining) = request.remaining_ms.filter(|ms| *ms > 1000) else {
            initial.error(input, ErrorCode::InvalidRequest).await;
            return;
        };
        if serde_json::from_str::<Empty>(request.params.get()).is_err() {
            initial.error(input, ErrorCode::InvalidRequest).await;
            return;
        }
        let Ok(_capacity) = Arc::clone(&self.capacity).try_acquire_owned() else {
            initial.error(input, ErrorCode::ResourceExhausted).await;
            return;
        };
        let setup = async {
            let mut scope = self.authority.current(run, None).await?;
            let connection = self.authority.connection(run, &scope).await?;
            scope.expires = scope.expires.min(connection.expires_at);
            let socket = client::Client::connect(
                &connection.cdp_url,
                self.network.as_ref(),
                Arc::clone(&self.tls),
            )
            .await?;
            Ok::<_, Failure>((scope, socket))
        };
        let Some(Ok((scope, socket))) = initial.wait(setup).await else {
            initial.error(input, ErrorCode::Unavailable).await;
            return;
        };
        let transport_deadline = started + Duration::from_millis(remaining.min(MAX_DURATION_MS));
        let stream_cancelled = initial.cancelled.child_token();
        let guest_ended = tokio_util::sync::CancellationToken::new();
        let (client, mut events) = client::Client::start(socket, &stream_cancelled);
        let upstream_cancelled = client.cancelled();
        let mut broker = Broker::new(client, scope);
        let (read, write) = tokio::io::split(input);
        let mut output = Writer::responses(write);
        let (send, mut receive) = mpsc::channel(8);
        let budget = Arc::new(Semaphore::new(8 * 1024 * 1024));
        let input_cancelled = stream_cancelled.clone();
        let input_ended = guest_ended.clone();
        // A single owned reader retains in-progress framing across other work.
        // Cancelling a partial Reader and polling it again would corrupt IO.
        let reader = tokio::spawn(async move {
            let mut reader = Reader::input(read);
            loop {
                match messages::read(&mut reader, MAX_MESSAGE_BYTES).await {
                    Ok(Some(messages::Message::Data(bytes))) => {
                        let Ok(permit) = Arc::clone(&budget)
                            .acquire_many_owned(bytes.len() as u32)
                            .await
                        else {
                            break;
                        };
                        if send.send((bytes, permit)).await.is_err() {
                            break;
                        }
                    }
                    Ok(Some(messages::Message::End)) => {
                        input_ended.cancel();
                        input_cancelled.cancel();
                        break;
                    }
                    _ => {
                        input_cancelled.cancel();
                        break;
                    }
                }
            }
        });
        let mut check = tokio::time::interval(Duration::from_secs(2));
        check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let result: Result<()> = async {
            loop {
                let expiry = Instant::now()
                    + Duration::from_millis(broker.scope.expires.saturating_sub(authority::now()));
                let mut guard = guest_rpc::Scope {
                    cancelled: stream_cancelled.clone(),
                    sandbox_cancelled: initial.sandbox_cancelled.clone(),
                    deadline: transport_deadline.min(expiry),
                };
                let next = tokio::select! {
                    biased;
                    () = guest_ended.cancelled() => return Ok(()),
                    () = upstream_cancelled.cancelled() => return Err(Failure),
                    next = guard.wait(async {
                        tokio::select! {
                            incoming = receive.recv() => (incoming, None, false),
                            event = events.recv() => (None, event, false),
                            _ = check.tick() => (None, None, true),
                        }
                    }) => next.ok_or(Failure)?,
                };
                guard.deadline = guard.deadline.min(Instant::now() + Duration::from_secs(30));
                if next.2 {
                    guard
                        .wait(self.refresh(run, &mut broker))
                        .await
                        .ok_or(Failure)??;
                    guard
                        .wait(broker.verify_sessions())
                        .await
                        .ok_or(Failure)??;
                    continue;
                }
                if let Some((bytes, _permit)) = next.0 {
                    if bytes.is_empty() {
                        return Err(Failure);
                    }
                    let message: Value = serde_json::from_slice(&bytes).map_err(|_| Failure)?;
                    guard
                        .wait(self.refresh(run, &mut broker))
                        .await
                        .ok_or(Failure)??;
                    let result = guard
                        .wait(broker.dispatch(message))
                        .await
                        .ok_or(Failure)??;
                    guard
                        .wait(self.refresh(run, &mut broker))
                        .await
                        .ok_or(Failure)??;
                    let bytes = serde_json::to_vec(&result).map_err(|_| Failure)?;
                    guard
                        .wait(messages::write(&mut output, &bytes, MAX_MESSAGE_BYTES))
                        .await
                        .ok_or(Failure)?
                        .map_err(|_| Failure)?;
                } else if let Some(event) = next.1 {
                    guard
                        .wait(self.refresh(run, &mut broker))
                        .await
                        .ok_or(Failure)??;
                    if let Some(event) = guard
                        .wait(broker.event(event.value))
                        .await
                        .ok_or(Failure)??
                    {
                        let bytes = serde_json::to_vec(&event).map_err(|_| Failure)?;
                        guard
                            .wait(messages::write(&mut output, &bytes, MAX_MESSAGE_BYTES))
                            .await
                            .ok_or(Failure)?
                            .map_err(|_| Failure)?;
                    }
                } else {
                    return Ok(());
                }
            }
        }
        .await;
        reader.abort();
        let _ = reader.await;
        broker.client.shutdown().await;
        let terminal = async {
            if result.is_ok() {
                output.send(&Frame::End).await?;
                output
                    .send(&Frame::Control(Response::Result {
                        data: RawValue::from_string(json!({"closed":true}).to_string())?,
                    }))
                    .await
            } else if output.is_usable() {
                output
                    .send(&Frame::Control(Response::error(
                        ErrorCode::Unavailable,
                        Delivery::Unknown,
                    )))
                    .await
            } else {
                Ok(())
            }
        };
        let _ = tokio::time::timeout(Duration::from_secs(1), terminal).await;
    }
}
