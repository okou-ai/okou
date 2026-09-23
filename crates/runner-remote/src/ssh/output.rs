//! Bounded SSH business payloads inside the opaque RPC envelopes.

use base64::Engine;
use runner_rpc_proto::{Response, ResponseWriter};
use serde::Serialize;

use super::{FailureReason, io::GuestIo};

pub(super) const CHUNK_BYTES: usize = 16 * 1024;
const STREAM_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Stream {
    Stdout,
    Stderr,
}

#[derive(Default)]
struct Capture {
    pending: Vec<u8>,
    bytes: usize,
    truncated: bool,
}

#[derive(Default)]
pub(super) struct Output {
    pub(super) connection: super::observation::Attempt,
    stdout: Capture,
    stderr: Capture,
    attempted: bool,
    accepted: bool,
    failure: Option<FailureReason>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum RemoteExit {
    Status {
        code: u32,
    },
    Signal {
        signal: &'static str,
        core_dumped: bool,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Effects {
    NotStarted,
    Unknown,
    Completed,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Terminal {
    Finished { exit: RemoteExit },
    Failed { failure_reason: FailureReason },
}

impl Output {
    pub(super) fn attempted(&mut self) {
        self.attempted = true;
    }
    pub(super) fn rejected(&mut self) {
        self.attempted = false;
    }
    pub(super) fn is_accepted(&self) -> bool {
        self.accepted
    }

    pub(super) async fn accept(
        &mut self,
        writer: &mut ResponseWriter<GuestIo>,
    ) -> Result<(), FailureReason> {
        #[derive(Serialize)]
        struct Accepted {
            r#type: &'static str,
        }
        event(writer, &Accepted { r#type: "accepted" }).await?;
        self.accepted = true;
        Ok(())
    }

    pub(super) async fn data(
        &mut self,
        writer: &mut ResponseWriter<GuestIo>,
        stream: Stream,
        data: &[u8],
    ) -> Result<(), FailureReason> {
        if !self.accepted {
            return Err(FailureReason::Protocol);
        }
        let capture = match stream {
            Stream::Stdout => &mut self.stdout,
            Stream::Stderr => &mut self.stderr,
        };
        let take = data.len().min(STREAM_BYTES - capture.bytes);
        capture.truncated |= take < data.len();
        capture.bytes += take;
        for part in data.split_at(take).0.chunks(CHUNK_BYTES) {
            // Keep only one chunk in each stream's coalescing buffer.
            let room = CHUNK_BYTES - capture.pending.len();
            let (head, tail) = part.split_at(part.len().min(room));
            capture.pending.extend_from_slice(head);
            if capture.pending.len() == CHUNK_BYTES {
                flush(writer, stream, capture).await?;
            }
            if part.len() > room {
                capture.pending.extend_from_slice(tail);
            }
        }
        Ok(())
    }

    pub(super) async fn flush(
        &mut self,
        writer: &mut ResponseWriter<GuestIo>,
    ) -> Result<(), FailureReason> {
        flush(writer, Stream::Stdout, &mut self.stdout).await?;
        flush(writer, Stream::Stderr, &mut self.stderr).await
    }

    pub(super) fn terminal(&mut self, result: Result<RemoteExit, FailureReason>) -> Terminal {
        match result {
            Ok(exit) => Terminal::Finished { exit },
            Err(failure_reason) => {
                self.failure = Some(failure_reason);
                Terminal::Failed { failure_reason }
            }
        }
    }

    pub(super) async fn finish(
        &mut self,
        writer: &mut ResponseWriter<GuestIo>,
        terminal: Terminal,
    ) -> Result<(), FailureReason> {
        self.flush(writer).await?;
        #[derive(Serialize)]
        struct ResultData {
            #[serde(flatten)]
            terminal: Terminal,
            effects: Effects,
            stdout_bytes: usize,
            stderr_bytes: usize,
            stdout_truncated: bool,
            stderr_truncated: bool,
        }
        let effects = match terminal {
            Terminal::Finished { .. } => Effects::Completed,
            Terminal::Failed { .. } if self.attempted => Effects::Unknown,
            Terminal::Failed { .. } => Effects::NotStarted,
        };
        let data = serde_json::value::to_raw_value(&ResultData {
            terminal,
            effects,
            stdout_bytes: self.stdout.bytes,
            stderr_bytes: self.stderr.bytes,
            stdout_truncated: self.stdout.truncated,
            stderr_truncated: self.stderr.truncated,
        })
        .map_err(|_| FailureReason::Protocol)?;
        writer
            .send(&Response::Result { data })
            .await
            .map_err(|_| FailureReason::Transport)
    }

    pub(super) fn outcome(&self) -> &'static str {
        if self.failure.is_some() {
            "failed"
        } else {
            "finished"
        }
    }
    pub(super) fn stdout_bytes(&self) -> usize {
        self.stdout.bytes
    }
    pub(super) fn failure(&self) -> Option<FailureReason> {
        self.failure
    }
    pub(super) fn stdout_truncated(&self) -> bool {
        self.stdout.truncated
    }
    pub(super) fn stderr_truncated(&self) -> bool {
        self.stderr.truncated
    }
    pub(super) fn stderr_bytes(&self) -> usize {
        self.stderr.bytes
    }
}

async fn flush(
    writer: &mut ResponseWriter<GuestIo>,
    stream: Stream,
    capture: &mut Capture,
) -> Result<(), FailureReason> {
    if capture.pending.is_empty() {
        return Ok(());
    }
    #[derive(Serialize)]
    struct Data {
        r#type: &'static str,
        stream: Stream,
        data: String,
    }
    let data = base64::engine::general_purpose::STANDARD.encode(&capture.pending);
    event(
        writer,
        &Data {
            r#type: "output",
            stream,
            data,
        },
    )
    .await?;
    capture.pending.clear();
    Ok(())
}

async fn event(
    writer: &mut ResponseWriter<GuestIo>,
    data: &impl Serialize,
) -> Result<(), FailureReason> {
    let data = serde_json::value::to_raw_value(data).map_err(|_| FailureReason::Protocol)?;
    writer
        .send(&Response::Event { data })
        .await
        .map_err(|_| FailureReason::Transport)
}
