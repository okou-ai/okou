//! Actual packaged Guest worker exercised through the Runner's registry/Channel.
//! The caller owns the sandbox and keeps this same registry across park/reuse.

use base64::{Engine, engine::general_purpose::STANDARD};
use guest_contracts::sandbox_channel::{
    Message, Operation, decode_message, decode_params, decode_result,
};
use serde_json::{Value, json};
use std::{io, time::Duration};

use runner_remote::guest_duplex::{Channel, MAX_STREAMS_PER_RUN, Registration, RunGuestChannels};
use runner_types::ids::RunId;
use sandbox::Sandbox;
use tokio_util::sync::CancellationToken;

use super::TestResult;

const DEADLINE: Duration = Duration::from_secs(5);

pub(super) struct LiveEpoch {
    registration: Registration,
    idle: Channel,
}

impl LiveEpoch {
    pub(super) async fn retire(self) -> TestResult<()> {
        let Self {
            registration,
            mut idle,
        } = self;
        let observer = idle.cancellation();
        // Match executor teardown: registration retirement precedes sandbox park.
        // Cancellation must be observable without starting either direction's IO.
        drop(registration);
        tokio::time::timeout(DEADLINE, observer.cancelled()).await?;
        if idle.send(b"retired").await.is_ok() {
            return Err(io::Error::other("retired Guest epoch still accepted data").into());
        }
        drop(idle);
        Ok(())
    }

    pub(super) async fn verify_provider_stop(self, sandbox: &mut dyn Sandbox) -> TestResult<()> {
        let observer = self.idle.cancellation();
        // Keep both the registry entry and the native stream alive: only the real
        // provider's assignment cancellation can close this idle connection.
        sandbox.stop().await?;
        tokio::time::timeout(DEADLINE, observer.cancelled()).await?;
        let Self {
            registration,
            mut idle,
        } = self;
        if idle.send(b"stopped").await.is_ok() {
            return Err(io::Error::other("stopped Guest still accepted data").into());
        }
        drop(idle);
        drop(registration);
        Ok(())
    }
}

pub(super) async fn exercise(
    sandbox: &dyn Sandbox,
    run: &str,
    registry: &RunGuestChannels,
) -> TestResult<LiveEpoch> {
    let run_id: RunId = run.parse()?;
    let registration = registry
        .register(run_id, sandbox, &CancellationToken::new())
        .ok_or_else(|| io::Error::other("packaged Guest duplex assignment missing"))?;
    if registry
        .open_for_sandbox(run_id, "different-sandbox")
        .await
        .is_ok()
    {
        return Err(io::Error::other("wrong sandbox obtained native Guest access").into());
    }
    let mut streams = Vec::new();
    for index in 0..MAX_STREAMS_PER_RUN {
        // Native accept waits for the initialized Guest worker's ACTIVATED reply.
        let mut channel =
            tokio::time::timeout(DEADLINE, registry.open_for_sandbox(run_id, sandbox.id()))
                .await??;
        hello(&mut channel).await?;
        diagnostics(&mut channel, &[index as u8, 0, 255, 128], true).await?;
        streams.push(channel);
    }
    match registry.open_for_sandbox(run_id, sandbox.id()).await {
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => (),
        _ => return Err(io::Error::other("native run exceeded eight active streams").into()),
    }
    // Both the Runner permit and the physical Guest worker must become reusable.
    drop(streams.pop());
    let mut recovered =
        tokio::time::timeout(DEADLINE, registry.open_for_sandbox(run_id, sandbox.id())).await??;
    hello(&mut recovered).await?;
    diagnostics(&mut recovered, &[], false).await?;
    let full_echo: Vec<u8> = (0..16384).map(|index| index as u8).collect();
    diagnostics(&mut recovered, &full_echo, true).await?;
    tokio::time::timeout(DEADLINE, async {
        recovered.finish_send().await?;
        if recovered.recv().await?.is_some() {
            return Err(io::Error::other("Guest FIN did not produce direction EOF"));
        }
        Ok::<_, io::Error>(())
    })
    .await??;
    drop(recovered);
    let idle = streams
        .pop()
        .ok_or_else(|| io::Error::other("missing idle native stream"))?;
    drop(streams);
    Ok(LiveEpoch { registration, idle })
}

async fn send(channel: &mut Channel, value: Value) -> TestResult<()> {
    channel.send(&serde_json::to_vec(&value)?).await?;
    Ok(())
}
async fn receive(channel: &mut Channel) -> TestResult<Message> {
    let bytes = channel
        .recv()
        .await?
        .ok_or_else(|| io::Error::other("Guest protocol EOF"))?;
    Ok(decode_message(&bytes)?)
}
async fn hello(channel: &mut Channel) -> TestResult<()> {
    tokio::time::timeout(DEADLINE, async {
        let id = uuid::Uuid::new_v4().to_string();
        send(
            channel,
            json!({"schemaVersion":1,"type":"hello","id":id,"categories":{"diagnostics":1}}),
        )
        .await?;
        match receive(channel).await? {
            Message::Response {
                request_id,
                result: Some(result),
                error: None,
                ..
            } if request_id == id
                && result
                    .get("categories")
                    .and_then(|value| value.get("diagnostics"))
                    .and_then(Value::as_u64)
                    == Some(1) =>
            {
                ()
            }
            _ => return Err(io::Error::other("packaged Guest hello mismatch").into()),
        }
        match receive(channel).await? {
            Message::Event {
                category,
                category_version: 1,
                event,
                data,
                ..
            } if category == "diagnostics"
                && event == "notice"
                && data == json!({"message":"ready"}) =>
            {
                ()
            }
            _ => {
                return Err(
                    io::Error::other("first Guest business event did not follow hello").into(),
                );
            }
        }
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
    })
    .await??;
    Ok(())
}
async fn diagnostics(channel: &mut Channel, expected: &[u8], reverse: bool) -> TestResult<()> {
    tokio::time::timeout(DEADLINE, async {
        let id = uuid::Uuid::new_v4().to_string();
        let payload = STANDARD.encode(expected);
        let operation = if reverse { "peer.echo" } else { "echo" };
        send(channel, json!({"schemaVersion":1,"type":"request","id":id,"category":"diagnostics","categoryVersion":1,"operation":operation,"params":{"payload":payload}})).await?;
        let mut reverse_count = 0;
        loop {
            match receive(channel).await? {
                Message::Request { id: reverse_id, category, category_version:1, operation, params, .. }
                    if reverse && category == "diagnostics" && operation == "echo" => {
                    decode_params(Operation::Echo, params.clone())?;
                    if params != json!({"payload":payload}) || reverse_count != 0 {
                        return Err(io::Error::other("packaged reverse echo mismatch").into());
                    }
                    reverse_count += 1;
                    send(channel, json!({"schemaVersion":1,"type":"response","id":uuid::Uuid::new_v4().to_string(),"requestId":reverse_id,"result":params})).await?;
                }
                Message::Response { id: response_id, request_id, result:Some(result), error:None, .. }
                    if request_id == id && response_id != id => {
                    decode_result(Operation::Echo, result.clone())?;
                    if result != json!({"payload":payload}) || reverse_count != usize::from(reverse) {
                        return Err(io::Error::other("packaged diagnostics result mismatch").into());
                    }
                    return Ok::<_, Box<dyn std::error::Error + Send + Sync>>(());
                }
                _ => return Err(io::Error::other("unexpected packaged Guest protocol message").into()),
            }
        }
    }).await??;
    Ok(())
}
