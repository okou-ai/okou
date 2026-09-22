//! Generation-fenced, private local IPC for one-shot exact idle reclamation.

use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

use runner_host::host_file::{DirMode, ensure_dir, validate_dir};
use runner_host::paths::HomePaths;
use runner_host::runner_process_identity::RunnerProcessIdentity;

const FRAME_LIMIT: usize = 4096;
const IO_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PruneIdleReport {
    pub selected: usize,
    pub completed: usize,
    pub uncertain: usize,
}

pub(crate) type PruneIdleResponse = Result<PruneIdleReport, String>;

pub(crate) struct PruneIdleListener {
    listener: UnixListener,
    path: PathBuf,
    inode: u64,
}

impl PruneIdleListener {
    pub(crate) fn bind(
        home: &HomePaths,
        base_dir: &Path,
        identity: RunnerProcessIdentity,
    ) -> io::Result<Self> {
        ensure_dir(
            &home.runner_control_dir(),
            DirMode::Private,
            "runner control",
        )?;
        let path = socket_path(home, &base_dir.canonicalize()?, identity);
        // Never unlink an existing endpoint to make bind succeed: it may still
        // belong to a live process. Generations use independent endpoints.
        let listener = UnixListener::bind(&path)?;
        let inode = std::fs::symlink_metadata(&path)?.ino();
        let server = Self {
            listener,
            path,
            inode,
        };
        std::fs::set_permissions(&server.path, std::fs::Permissions::from_mode(0o600))?;
        Ok(server)
    }

    pub(crate) async fn accept(&self) -> io::Result<UnixStream> {
        self.listener.accept().await.map(|(stream, _)| stream)
    }
}

impl Drop for PruneIdleListener {
    fn drop(&mut self) {
        if let Ok(metadata) = std::fs::symlink_metadata(&self.path)
            && metadata.ino() == self.inode
            && let Err(error) = std::fs::remove_file(&self.path)
        {
            tracing::warn!(%error, "failed to remove runner prune endpoint");
        }
    }
}

fn socket_path(home: &HomePaths, base_dir: &Path, identity: RunnerProcessIdentity) -> PathBuf {
    let mut digest = Sha256::new();
    digest.update(base_dir.as_os_str().as_encoded_bytes());
    digest.update([0]);
    digest.update(identity.runner_id().as_bytes());
    digest.update(identity.heartbeat_generation().to_le_bytes());
    // Keep the Unix socket pathname short. Full identity is also checked in
    // the request, so a digest collision can fail bind but cannot authorize it.
    let digest = digest.finalize();
    let (prefix, _) = digest.split_at(16);
    home.runner_control_dir().join(hex::encode(prefix))
}

pub(crate) async fn read_request(
    stream: &mut UnixStream,
    identity: RunnerProcessIdentity,
) -> io::Result<()> {
    verify_peer(stream, None)?;
    let expected: RunnerProcessIdentity = read_frame(stream).await?;
    if expected != identity {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "runner generation mismatch",
        ));
    }
    Ok(())
}

fn verify_peer(stream: &UnixStream, expected_pid: Option<u32>) -> io::Result<()> {
    let peer = stream.peer_cred()?;
    if peer.uid() != nix::unistd::geteuid().as_raw()
        || expected_pid
            .is_some_and(|pid| peer.pid().and_then(|pid| u32::try_from(pid).ok()) != Some(pid))
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "runner control peer mismatch",
        ));
    }
    Ok(())
}

pub(crate) async fn request(
    home: &HomePaths,
    base_dir: &Path,
    identity: RunnerProcessIdentity,
    expected_pid: u32,
) -> io::Result<PruneIdleResponse> {
    validate_dir(
        &home.runner_control_dir(),
        DirMode::Private,
        "runner control",
    )?;
    let mut stream = UnixStream::connect(socket_path(home, base_dir, identity)).await?;
    verify_peer(&stream, Some(expected_pid))?;
    write_frame(&mut stream, &identity).await?;
    // Physical reclamation is bounded by the operator's whole-command timeout,
    // not the short framing timeout used for incoming requests.
    read_frame_unbounded(&mut stream).await
}

pub(crate) async fn write_response(
    stream: &mut UnixStream,
    response: &PruneIdleResponse,
) -> io::Result<()> {
    write_frame(stream, response).await
}

async fn read_frame<T: DeserializeOwned>(stream: &mut UnixStream) -> io::Result<T> {
    tokio::time::timeout(IO_TIMEOUT, read_frame_unbounded(stream))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "runner control read timed out"))?
}

async fn read_frame_unbounded<T: DeserializeOwned>(stream: &mut UnixStream) -> io::Result<T> {
    let length = stream.read_u32().await? as usize;
    if length > FRAME_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "runner control frame too large",
        ));
    }
    let mut data = vec![0; length];
    stream.read_exact(&mut data).await?;
    serde_json::from_slice(&data).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

async fn write_frame<T: Serialize>(stream: &mut UnixStream, value: &T) -> io::Result<()> {
    let data = serde_json::to_vec(value).map_err(io::Error::other)?;
    if data.len() > FRAME_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "runner control frame too large",
        ));
    }
    tokio::time::timeout(IO_TIMEOUT, async {
        stream.write_u32(data.len() as u32).await?;
        stream.write_all(&data).await
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "runner control write timed out"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn prune_idle_control_round_trip_is_generation_and_peer_fenced() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1).unwrap();
        let listener = PruneIdleListener::bind(&home, dir.path(), identity).unwrap();
        let path = listener.path.clone();
        let replaced = RunnerProcessIdentity::new(identity.runner_id(), 2).unwrap();
        assert!(
            request(&home, dir.path(), replaced, std::process::id())
                .await
                .is_err()
        );
        assert!(
            request(&home, dir.path(), identity, u32::MAX)
                .await
                .is_err()
        );
        // Consume the connection rejected by the client peer check.
        drop(listener.accept().await.unwrap());
        let server = tokio::spawn(async move {
            let mut stream = listener.accept().await.unwrap();
            read_request(&mut stream, identity).await.unwrap();
            write_response(
                &mut stream,
                &Ok(PruneIdleReport {
                    selected: 3,
                    completed: 3,
                    uncertain: 0,
                }),
            )
            .await
            .unwrap();
        });
        let report = request(&home, dir.path(), identity, std::process::id())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(report.completed, 3);
        server.await.unwrap();
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn prune_idle_control_rejects_wrong_generation_and_oversized_requests() {
        let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1).unwrap();
        let wrong = RunnerProcessIdentity::new(identity.runner_id(), 2).unwrap();
        let (mut client, mut server) = UnixStream::pair().unwrap();
        write_frame(&mut client, &wrong).await.unwrap();
        assert_eq!(
            read_request(&mut server, identity)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        client.write_u32((FRAME_LIMIT + 1) as u32).await.unwrap();
        assert_eq!(
            read_request(&mut server, identity)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }
}
