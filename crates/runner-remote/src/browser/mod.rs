//! Window-scoped CDP using existing Runner authority and binary Guest RPC.

mod authority;
mod broker;
mod client;
mod policy;
#[cfg(test)]
mod tests;

use api_contracts::generated::constants::runners::OFFICIAL_RUNNER_TOKEN_PREFIX;
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_provider::HttpClient;
use runner_rpc_proto::{
    Delivery, ErrorCode, Response,
    stream::{Frame, Reader, Writer, messages},
};
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};
use std::{sync::Arc, time::Duration};
use tokio::sync::{Semaphore, mpsc};

use crate::{
    RemoteInitError,
    destination::{Network, PublicNetwork},
    guest_rpc,
};
use broker::Broker;

// Match tungstenite's normal complete-message scale, including large captures.
pub(super) const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const QUEUE_BYTES: usize = 8 * 1024 * 1024;
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

    pub(crate) async fn dispatch(&self, args: guest_rpc::Request) {
        let guest_rpc::Request {
            input,
            lease,
            run,
            deadline,
            cancelled,
            sandbox_cancelled,
            request,
            ..
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
        if !request.remaining_ms.is_some_and(|ms| ms > 1000)
            || serde_json::from_str::<Empty>(request.params.get()).is_err()
        {
            initial.error(input, ErrorCode::InvalidRequest).await;
            return;
        }
        let Ok(capacity) = Arc::clone(&self.capacity).try_acquire_owned() else {
            initial.error(input, ErrorCode::ResourceExhausted).await;
            return;
        };
        let capacity = Arc::new(capacity);
        let setup = async {
            let scope = self.authority.inspect(run).await?;
            let connection = self.authority.connection(run, &scope).await?;
            let socket = client::Client::connect(
                &connection.cdp_url,
                Arc::clone(&self.network),
                Arc::clone(&self.tls),
                Arc::clone(&capacity),
            )
            .await?;
            Ok::<_, Failure>((scope, socket))
        };
        let Some(Ok((scope, socket))) = initial.wait(setup).await else {
            initial.error(input, ErrorCode::Unavailable).await;
            return;
        };
        let stream_cancelled = initial.cancelled.child_token();
        let guest_ended = tokio_util::sync::CancellationToken::new();
        let (client, mut events) = client::Client::start(socket, &stream_cancelled);
        let upstream_cancelled = client.cancelled();
        let mut broker = Broker::new(client, scope);
        let (read, write) = tokio::io::split(input);
        let mut output = Writer::responses(write);
        let (send, mut receive) = mpsc::channel(8);
        let budget = Arc::new(Semaphore::new(QUEUE_BYTES));
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
                            // One large message consumes the whole queue budget;
                            // it must not wait for more permits than can exist.
                            .acquire_many_owned(bytes.len().min(QUEUE_BYTES) as u32)
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
        let forwarding = async {
            loop {
                let next = tokio::select! {
                    incoming = receive.recv() => (incoming, None),
                    event = events.recv() => (None, event),
                };
                if let Some((bytes, _permit)) = next.0 {
                    if bytes.is_empty() {
                        return Err(Failure);
                    }
                    let message: Value = serde_json::from_slice(&bytes).map_err(|_| Failure)?;
                    drop(bytes);
                    let result = broker.dispatch(message).await?;
                    let bytes = serde_json::to_vec(&result).map_err(|_| Failure)?;
                    drop(result);
                    messages::write(&mut output, &bytes, MAX_MESSAGE_BYTES)
                        .await
                        .map_err(|_| Failure)?;
                } else if let Some(event) = next.1 {
                    if let Some(event) = broker.event(event.value).await? {
                        let bytes = serde_json::to_vec(&event).map_err(|_| Failure)?;
                        drop(event);
                        messages::write(&mut output, &bytes, MAX_MESSAGE_BYTES)
                            .await
                            .map_err(|_| Failure)?;
                    }
                } else {
                    return Ok(());
                }
            }
        };
        // Authorization belongs to establishment. Run/Guest cancellation and
        // native Browser instance closure own the established stream lifetime.
        let result: Result<()> = tokio::select! {
            biased;
            () = guest_ended.cancelled() => Ok(()),
            () = stream_cancelled.cancelled() => Err(Failure),
            () = initial.sandbox_cancelled.cancelled() => Err(Failure),
            () = upstream_cancelled.cancelled() => Err(Failure),
            result = forwarding => result,
        };
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
