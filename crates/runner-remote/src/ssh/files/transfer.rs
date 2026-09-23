//! Stage first; only a fully acknowledged transfer may publish a destination.

use runner_rpc_proto::stream::{Frame, MAX_STREAM_BYTES, Reader, Writer};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite};
use uuid::Uuid;

use super::{
    protocol::{Direction, Effects, Failure, FileFailure, Outcome, PATH_BYTES, Request},
    sftp::{CHUNK, Client, Error},
};
use crate::ssh::FailureReason;

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
        if !self.owned || !client.healthy() {
            return Ok(());
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
    loop {
        match input.next().await.map_err(|_| FailureReason::Protocol)? {
            Some(Frame::Data(bytes)) => {
                if Some(outcome.bytes + bytes.len() as u64) > request.size {
                    return Err(FileFailure::SourceChanged.into());
                }
                for chunk in bytes.chunks(CHUNK) {
                    client.write_file(&handle, outcome.bytes, chunk).await?;
                    hash.update(chunk);
                    outcome.bytes += chunk.len() as u64;
                }
            }
            Some(Frame::End) => break,
            _ => return Err(FailureReason::Protocol.into()),
        }
    }
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
    while let Some(bytes) = client.read_file(&handle, outcome.bytes).await? {
        if outcome.bytes + bytes.len() as u64 > size {
            return Err(FileFailure::SourceChanged.into());
        }
        output
            .send(&Frame::Data(bytes.clone()))
            .await
            .map_err(|_| FailureReason::Transport)?;
        hash.update(&bytes);
        outcome.bytes += bytes.len() as u64;
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
