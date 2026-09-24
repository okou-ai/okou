//! Stage first; only a fully acknowledged transfer may publish a destination.

use std::collections::BTreeMap;

use runner_rpc_proto::stream::{Frame, MAX_STREAM_BYTES, Reader, Writer};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite};
use uuid::Uuid;

use super::{
    protocol::{Direction, Effects, Failure, FileFailure, Outcome, PATH_BYTES, Request},
    sftp::{CHUNK, Client, Error, FileReply},
};
use crate::ssh::FailureReason;

const WINDOW: usize = 8;

#[derive(Default)]
pub(super) struct Staging {
    directory: String,
    file: String,
    owned: bool,
    file_exists: bool,
    handle: Option<Vec<u8>>,
}

impl Staging {
    /// Only the same healthy channel may clean its acknowledged private staging.
    pub(super) async fn cleanup<S: AsyncRead + AsyncWrite + Unpin>(
        &mut self,
        client: &mut Client<S>,
        outcome: &mut Outcome,
    ) -> Result<(), Error> {
        if !self.owned {
            return Ok(());
        }
        if !client.healthy() {
            client.settle_file_requests().await?;
        }
        if let Some(handle) = self.handle.take() {
            client.close(&handle).await?;
        }
        if self.file_exists {
            client.remove(&self.file, false).await?;
            self.file_exists = false;
        }
        client.remove(&self.directory, true).await?;
        self.owned = false;
        outcome.residue = None;
        Ok(())
    }
}

pub(super) async fn run<S, R, W>(
    request: &Request,
    client: &mut Client<S>,
    input: &mut Reader<R>,
    output: &mut Writer<W>,
    outcome: &mut Outcome,
    staging: &mut Staging,
) -> Result<(), Failure>
where
    S: AsyncRead + AsyncWrite + Unpin,
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let (parent, name) = request
        .path
        .rsplit_once('/')
        .unwrap_or((".", &request.path));
    let parent = client
        .realpath(if parent.is_empty() { "/" } else { parent })
        .await?;
    if !client
        .lstat(&parent)
        .await?
        .is_some_and(|attrs| attrs.directory())
    {
        return Err(FileFailure::PathNotFound.into());
    }
    let path = format!("{}/{name}", parent.trim_end_matches('/'));
    if path.len() > PATH_BYTES {
        return Err(FileFailure::InvalidPath.into());
    }
    match request.direction {
        Direction::Upload => upload(request, client, input, outcome, staging, &parent, &path).await,
        Direction::Download => download(client, output, outcome, &path).await,
    }
}

async fn destination<S: AsyncRead + AsyncWrite + Unpin>(
    client: &mut Client<S>,
    path: &str,
    overwrite: bool,
) -> Result<(), Failure> {
    if let Some(attrs) = client.lstat(path).await? {
        if !attrs.regular() {
            return Err(FileFailure::NotRegularFile.into());
        }
        if !overwrite {
            return Err(FileFailure::DestinationExists.into());
        }
    }
    Ok(())
}

async fn upload<S, R>(
    request: &Request,
    client: &mut Client<S>,
    input: &mut Reader<R>,
    outcome: &mut Outcome,
    staging: &mut Staging,
    parent: &str,
    path: &str,
) -> Result<(), Failure>
where
    S: AsyncRead + AsyncWrite + Unpin,
    R: AsyncRead + Unpin,
{
    if !(if request.overwrite {
        client.rename
    } else {
        client.hardlink
    }) {
        return Err(FileFailure::UnsupportedOperation.into());
    }
    destination(client, path, request.overwrite).await?;
    staging.directory = format!(
        "{}/.okou-transfer-{}",
        parent.trim_end_matches('/'),
        Uuid::new_v4()
    );
    staging.file = format!("{}/data", staging.directory);
    if staging.file.len() > PATH_BYTES {
        return Err(FileFailure::InvalidPath.into());
    }
    outcome.residue = Some(staging.directory.clone());
    if let Err(error) = client.mkdir(&staging.directory).await {
        if matches!(error, Error::Status(_)) {
            outcome.residue = None;
        }
        return Err(error.into());
    }
    staging.owned = true;
    let handle = client.open(&staging.file, true).await?;
    staging.file_exists = true;
    staging.handle = Some(handle.clone());
    let mut hash = Sha256::new();
    let mut pending = Vec::with_capacity(WINDOW);
    let mut queued_bytes = 0_u64;
    loop {
        match input.next().await.map_err(|_| FailureReason::Protocol)? {
            Some(Frame::Data(bytes)) => {
                if Some(outcome.bytes + queued_bytes + bytes.len() as u64) > request.size {
                    return Err(FileFailure::SourceChanged.into());
                }
                for chunk in bytes.chunks(CHUNK) {
                    let offset = outcome.bytes + queued_bytes;
                    let id = client.send_write_file(&handle, offset, chunk).await?;
                    pending.push((id, chunk.to_vec()));
                    queued_bytes += chunk.len() as u64;
                    if pending.len() == WINDOW {
                        acknowledge_writes(client, outcome, &mut hash, &mut pending).await?;
                        queued_bytes = 0;
                    }
                }
            }
            Some(Frame::End) => break,
            _ => return Err(FailureReason::Protocol.into()),
        }
    }
    acknowledge_writes(client, outcome, &mut hash, &mut pending).await?;
    if Some(outcome.bytes) != request.size {
        return Err(FileFailure::SourceChanged.into());
    }
    let attrs = client.fstat(&handle).await?;
    if !attrs.regular() || attrs.size != Some(outcome.bytes) {
        return Err(FileFailure::SourceChanged.into());
    }
    client.close(&handle).await?;
    staging.handle = None;
    destination(client, path, request.overwrite).await?;
    outcome.effects = Effects::Unknown;
    if let Err(error) = client.publish(&staging.file, path, request.overwrite).await {
        if matches!(error, Error::Status(_)) {
            outcome.effects = Effects::NotStarted;
        }
        return Err(error.into());
    }
    outcome.effects = Effects::Completed;
    if request.overwrite {
        staging.file_exists = false;
    }
    outcome.sha256 = Some(hex::encode(hash.finalize()));
    Ok(())
}

async fn acknowledge_writes<S: AsyncRead + AsyncWrite + Unpin>(
    client: &mut Client<S>,
    outcome: &mut Outcome,
    hash: &mut Sha256,
    pending: &mut Vec<(u32, Vec<u8>)>,
) -> Result<(), Failure> {
    // Drain the whole batch so a normal status error still leaves a usable
    // channel for private staging cleanup. Transport/protocol errors poison it.
    let mut replies = BTreeMap::new();
    for _ in 0..pending.len() {
        let (id, reply) = client.receive_file().await?;
        replies.insert(id, reply);
    }
    for (id, bytes) in pending.drain(..) {
        match replies.remove(&id) {
            Some(FileReply::Write(Ok(()))) => {
                hash.update(&bytes);
                outcome.bytes += bytes.len() as u64;
            }
            Some(FileReply::Write(Err(error))) => return Err(error.into()),
            _ => return Err(FailureReason::Protocol.into()),
        }
    }
    Ok(())
}

async fn download<S, W>(
    client: &mut Client<S>,
    output: &mut Writer<W>,
    outcome: &mut Outcome,
    path: &str,
) -> Result<(), Failure>
where
    S: AsyncRead + AsyncWrite + Unpin,
    W: AsyncWrite + Unpin,
{
    let observed = client.lstat(path).await?.ok_or(FileFailure::PathNotFound)?;
    if !observed.regular() {
        return Err(FileFailure::NotRegularFile.into());
    }
    let handle = client.open(path, false).await?;
    let before = client.fstat(&handle).await?;
    if !before.regular() {
        return Err(FileFailure::NotRegularFile.into());
    }
    if before != observed {
        return Err(FileFailure::SourceChanged.into());
    }
    let size = before.size.ok_or(FailureReason::Protocol)?;
    outcome.actual_bytes = Some(size);
    if size > MAX_STREAM_BYTES {
        return Err(FileFailure::FileTooLarge.into());
    }
    let mut hash = Sha256::new();
    let mut requested = 0_u64;
    while requested < size {
        let mut batch = Vec::with_capacity(WINDOW);
        while batch.len() < WINDOW && requested < size {
            let length = usize::try_from((size - requested).min(CHUNK as u64))
                .map_err(|_| FailureReason::Protocol)?;
            let id = client.send_read_file(&handle, requested, length).await?;
            batch.push((id, requested, length));
            requested += length as u64;
        }
        let mut replies = BTreeMap::new();
        for _ in 0..batch.len() {
            let (id, reply) = client.receive_file().await?;
            replies.insert(id, reply);
        }
        for (id, offset, length) in batch {
            let mut next = match replies.remove(&id) {
                Some(FileReply::Read(result)) => result?,
                _ => return Err(FailureReason::Protocol.into()),
            };
            let mut filled = 0;
            while filled < length {
                let bytes = next.take().ok_or(FileFailure::SourceChanged)?;
                let count = bytes.len();
                hash.update(&bytes);
                output
                    .send(&Frame::Data(bytes))
                    .await
                    .map_err(|_| FailureReason::Transport)?;
                outcome.bytes += count as u64;
                filled += count;
                if filled < length {
                    // SFTP v3 permits a short data reply. Fill its missing tail
                    // only after the batch has been received and reordered.
                    next = client
                        .read_file(&handle, offset + filled as u64, length - filled)
                        .await?;
                }
            }
        }
    }
    if outcome.bytes != size || client.fstat(&handle).await? != before {
        return Err(FileFailure::SourceChanged.into());
    }
    client.close(&handle).await?;
    outcome.sha256 = Some(hex::encode(hash.finalize()));
    // Runner completion means the remote stream was verified, not that the CLI
    // has published its local file. The CLI records publication independently.
    Ok(())
}
