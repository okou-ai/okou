//! Actual packaged Guest worker exercised through the Runner's registry/Channel.
//! The caller owns the sandbox and keeps this same registry across park/reuse.

use std::{io, time::Duration};

use runner_remote::guest_duplex::{
    Channel, MAX_FRAME_BYTES, MAX_STREAMS_PER_RUN, Registration, RunGuestChannels,
};
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
        echo(&mut channel, &[index as u8, 0, 255, 128]).await?;
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
    echo(&mut recovered, &[]).await?;
    let full_frame: Vec<u8> = (0..MAX_FRAME_BYTES).map(|index| index as u8).collect();
    echo(&mut recovered, &full_frame).await?;
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

async fn echo(channel: &mut Channel, expected: &[u8]) -> TestResult<()> {
    tokio::time::timeout(DEADLINE, async {
        channel.send(expected).await?;
        if channel.recv().await?.as_deref() != Some(expected) {
            return Err(io::Error::other("packaged Guest binary echo mismatch"));
        }
        Ok::<_, io::Error>(())
    })
    .await??;
    Ok(())
}
