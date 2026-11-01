use std::io;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tokio::net::UnixStream;

use super::exec_response::{ExecResult, read_raw_exec_response};
use super::protocol::{ExecRequest, TerminateRequest, TerminateResponse, read_frame, write_frame};

/// Send an exec request to a control socket and read its raw response.
pub(super) async fn send_exec(
    sock_path: &Path,
    request: &ExecRequest,
    timeout: Duration,
) -> io::Result<ExecResult> {
    let deadline = deadline_after(timeout)?;
    let mut stream = connect_until(sock_path, deadline).await?;
    let request_json = encode_json_request(request)?;

    tokio::time::timeout_at(deadline, async {
        write_frame(&mut stream, &request_json).await?;
        read_raw_exec_response(&mut stream).await
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "request timed out"))?
}

/// Send a host-side terminate request to a control socket.
pub async fn send_terminate(
    sock_path: &Path,
    request: &TerminateRequest,
    timeout: Duration,
) -> io::Result<TerminateResponse> {
    let deadline = deadline_after(timeout)?;
    let mut stream = connect_until(sock_path, deadline).await?;
    let request_json = encode_json_request(request)?;

    tokio::time::timeout_at(deadline, async {
        write_frame(&mut stream, &request_json).await?;
        let frame = read_frame(&mut stream).await?;
        serde_json::from_slice(&frame).map_err(|e| {
            io::Error::new(io::ErrorKind::InvalidData, format!("invalid response: {e}"))
        })
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "request timed out"))?
}

async fn connect_until(sock_path: &Path, deadline: tokio::time::Instant) -> io::Result<UnixStream> {
    tokio::time::timeout_at(deadline, UnixStream::connect(sock_path))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "connect timed out"))?
}

fn encode_json_request(request: &impl Serialize) -> io::Result<Vec<u8>> {
    serde_json::to_vec(request).map_err(|e| io::Error::other(format!("serialize request: {e}")))
}

fn deadline_after(timeout: Duration) -> io::Result<tokio::time::Instant> {
    tokio::time::Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "request timeout overflowed"))
}

#[cfg(test)]
mod tests;
