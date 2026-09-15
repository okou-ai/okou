//! One-request Runner-private addon control. Never automatically replay work.
//!
//! A timeout or lost reply after transmission is an unknown outcome. The only
//! startup probe may retry within its original readiness budget. Log flush
//! observes a writer-owned prefix and is never automatically replayed.

use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::time::Instant;
use uuid::Uuid;

const MAX_FRAME_BYTES: usize = 64 * 1024;
pub(super) const SOCKET_NAME: &str = "control.sock";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Request<'a, P> {
    request_id: &'a str,
    generation: &'a str,
    method: &'a str,
    params: P,
}

#[derive(Serialize)]
struct EmptyParams {}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Response<T> {
    Result {
        #[serde(rename = "requestId")]
        request_id: String,
        generation: String,
        data: T,
    },
    Error {
        #[serde(rename = "requestId")]
        request_id: Option<String>,
        generation: String,
        code: ErrorCode,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ErrorCode {
    InvalidRequest,
    StaleGeneration,
    UnknownMethod,
    Busy,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Status {
    state: State,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum State {
    Running,
}

/// Confirm initialized handlers for this exact generation, including terminal EOF.
pub(super) async fn status(
    directory: &Path,
    generation: &str,
    deadline: Instant,
) -> io::Result<()> {
    let Status {
        state: State::Running,
    } = exchange(
        directory,
        generation,
        "proxy.status",
        EmptyParams {},
        deadline,
    )
    .await?;
    Ok(())
}

pub(super) async fn exchange<P: Serialize, T: serde::de::DeserializeOwned>(
    directory: &Path,
    generation: &str,
    method: &str,
    params: P,
    deadline: Instant,
) -> io::Result<T> {
    tokio::time::timeout_at(deadline, async {
        let directory = tokio::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(directory)
            .await?;
        let metadata = directory.metadata().await?;
        if metadata.uid() != nix::unistd::geteuid().as_raw() || metadata.mode() & 0o077 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "addon control directory is not private to Runner",
            ));
        }
        // Keep the descriptor alive through connect. Both processes resolve
        // their own alias to the same launch inode, even with a long base path.
        let address = format!("/proc/self/fd/{}/{SOCKET_NAME}", directory.as_raw_fd());
        let mut stream = UnixStream::connect(address).await?;
        drop(directory);
        let request_id = Uuid::new_v4().to_string();
        let bytes = serde_json::to_vec(&Request {
            request_id: &request_id,
            generation,
            method,
            params,
        })?;
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(invalid("addon control request exceeds frame limit"));
        }
        stream.write_u32(bytes.len() as u32).await?;
        stream.write_all(&bytes).await?;
        let length = stream.read_u32().await? as usize;
        if length == 0 || length > MAX_FRAME_BYTES {
            return Err(invalid("invalid addon control response frame length"));
        }
        let mut bytes = vec![0; length];
        stream.read_exact(&mut bytes).await?;
        let response: Response<T> = serde_json::from_slice(&bytes)
            .map_err(|_| invalid("invalid addon control response"))?;
        if stream.read(&mut [0]).await? != 0 {
            return Err(invalid("unexpected bytes after addon control response"));
        }
        match response {
            Response::Result {
                request_id: actual_id,
                generation: actual_generation,
                data,
            } if actual_id == request_id && actual_generation == generation => Ok(data),
            Response::Error {
                request_id: Some(actual_id),
                generation: actual_generation,
                code,
            } if actual_id == request_id && actual_generation == generation => Err(
                io::Error::other(format!("addon control request rejected: {code:?}")),
            ),
            _ => Err(invalid("addon control response identity mismatch")),
        }
    })
    .await
    .map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "addon control deadline expired; no completed outcome confirmed",
        )
    })?
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests;
