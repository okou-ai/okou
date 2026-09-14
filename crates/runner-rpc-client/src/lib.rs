//! One-shot guest helper. No shell, files, payload logs, or request replay.

pub mod stream;

use std::future::Future;
use std::io;
use std::time::Duration;

use runner_rpc_proto::{Delivery, ErrorCode, MAX_REQUEST_BYTES, Response, ResponseReader};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::time::{Instant, timeout_at};

const TIMEOUT: Duration = Duration::from_secs(60);
const TERMINAL_BUDGET: Duration = Duration::from_millis(100);

/// Production entry point: only the fixed host CID and RPC port are reachable.
pub async fn run() -> io::Result<bool> {
    run_with_io(tokio::io::stdin(), tokio::io::stdout(), connect_vsock).await
}

/// Run one request with externally supplied I/O. The executable never exposes
/// a destination override. Returns true after a valid result, not business success.
pub async fn run_with_io<R, W, S, C, F>(mut input: R, mut output: W, connect: C) -> io::Result<bool>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    S: AsyncRead + AsyncWrite + Unpin,
    C: FnOnce() -> F,
    F: Future<Output = io::Result<S>>,
{
    let deadline = Instant::now() + TIMEOUT;
    let mut sent = false;
    let mut output_usable = true;
    let result = timeout_at(
        deadline - TERMINAL_BUDGET,
        exchange(
            &mut input,
            &mut output,
            connect,
            &mut sent,
            &mut output_usable,
            deadline - TERMINAL_BUDGET,
        ),
    )
    .await;
    if !output_usable {
        // A cancelled/failed partial NDJSON write cannot be safely retried.
        return Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "RPC output unavailable",
        ));
    }
    let terminal = match result
        .map_err(|_| ErrorCode::TimedOut)
        .and_then(std::convert::identity)
    {
        Ok(terminal) => terminal,
        Err(code) => Response::error(
            code,
            if sent {
                Delivery::Unknown
            } else {
                Delivery::NotDispatched
            },
        ),
    };
    timeout_at(deadline, emit(&mut output, &terminal))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "RPC output deadline"))??;
    Ok(matches!(terminal, Response::Result { .. }))
}

async fn exchange<R, W, S, C, F>(
    input: &mut R,
    output: &mut W,
    connect: C,
    sent: &mut bool,
    output_usable: &mut bool,
    deadline: Instant,
) -> Result<Response, ErrorCode>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    S: AsyncRead + AsyncWrite + Unpin,
    C: FnOnce() -> F,
    F: Future<Output = io::Result<S>>,
{
    let mut bytes = Vec::new();
    input
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| ErrorCode::InvalidRequest)?;
    let mut request =
        runner_rpc_proto::parse_request(&bytes).map_err(|_| ErrorCode::InvalidRequest)?;
    if request.remaining_ms.is_some() {
        return Err(ErrorCode::InvalidRequest);
    }
    let mut stream = connect().await.map_err(|_| ErrorCode::Unavailable)?;
    request.remaining_ms = Some(
        deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(60_000) as u64,
    );
    if serde_json::to_vec(&request)
        .map_err(|_| ErrorCode::InvalidRequest)?
        .len()
        > MAX_REQUEST_BYTES
    {
        return Err(ErrorCode::InvalidRequest);
    }
    // Once transmission is attempted, any subsequent loss may hide effects.
    *sent = true;
    runner_rpc_proto::write_request(&mut stream, &request)
        .await
        .map_err(|_| ErrorCode::Transport)?;
    stream.shutdown().await.map_err(|_| ErrorCode::Transport)?;
    let mut responses = ResponseReader::new(stream);
    let mut terminal = None;
    while let Some(response) = responses.next().await.map_err(|error| {
        if error.kind() == io::ErrorKind::InvalidData {
            ErrorCode::Protocol
        } else {
            ErrorCode::Transport
        }
    })? {
        if response.is_terminal() {
            terminal = Some(response);
        } else {
            *output_usable = false;
            emit(output, &response)
                .await
                .map_err(|_| ErrorCode::Transport)?;
            *output_usable = true;
        }
    }
    terminal.ok_or(ErrorCode::Protocol)
}

async fn emit(output: &mut (impl AsyncWrite + Unpin), response: &Response) -> io::Result<()> {
    let bytes = response.to_ndjson()?;
    output.write_all(&bytes).await?;
    output.flush().await
}

#[cfg(target_os = "linux")]
async fn connect_vsock() -> io::Result<UnixStream> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    // SAFETY: valid socket constants; ownership is adopted only on success.
    let raw = unsafe {
        libc::socket(
            libc::AF_VSOCK,
            libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
            0,
        )
    };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: this descriptor was just created and has exactly one owner.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let address = libc::sockaddr_vm {
        svm_family: libc::AF_VSOCK as u16,
        svm_reserved1: 0,
        svm_port: runner_rpc_proto::VSOCK_PORT,
        svm_cid: runner_rpc_proto::HOST_CID,
        svm_zero: [0; 4],
    };
    // SAFETY: the initialized sockaddr_vm has the matching length and remains
    // alive for the syscall; fd remains owned even on failure.
    let result = unsafe {
        libc::connect(
            fd.as_raw_fd(),
            std::ptr::from_ref(&address).cast(),
            std::mem::size_of_val(&address) as libc::socklen_t,
        )
    };
    if result < 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EINPROGRESS) {
        return Err(io::Error::last_os_error());
    }
    // AF_VSOCK stream descriptors support the same read/write/shutdown and
    // readiness operations. No AF_UNIX address operation is used here.
    let stream = UnixStream::from_std(std::os::unix::net::UnixStream::from(fd))?;
    if result < 0 {
        stream.writable().await?;
        if let Some(error) = stream.take_error()? {
            return Err(error);
        }
    }
    Ok(stream)
}

#[cfg(not(target_os = "linux"))]
async fn connect_vsock() -> io::Result<UnixStream> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "RPC transport requires Linux vsock",
    ))
}
