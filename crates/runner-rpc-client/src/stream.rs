//! Explicit framed stdin/stdout mode for bounded, bidirectional binary RPC.

use std::{future::Future, io, time::Duration};

use runner_rpc_proto::{
    ErrorCode, Response,
    stream::{Frame, MAX_DURATION_MS, Reader, Writer},
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    time::{Instant, timeout_at},
};

use crate::{TERMINAL_BUDGET, connect_vsock, dispatch_request, terminal_response};

pub async fn run() -> io::Result<bool> {
    run_with_io(tokio::io::stdin(), tokio::io::stdout(), connect_vsock).await
}

/// Same production bridge with caller-owned I/O for real-socket integration
/// tests. The executable always uses the fixed packaged vsock endpoint.
pub async fn run_with_io<R, W, S, C, F>(mut input: R, output: W, connect: C) -> io::Result<bool>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    S: AsyncRead + AsyncWrite + Unpin,
    C: FnOnce() -> F,
    F: Future<Output = io::Result<S>>,
{
    let deadline = Instant::now() + Duration::from_millis(MAX_DURATION_MS);
    let mut output = Writer::responses(output);
    let mut sent = false;
    let result = timeout_at(
        deadline - TERMINAL_BUDGET,
        exchange(
            &mut input,
            &mut output,
            connect,
            &mut sent,
            deadline - TERMINAL_BUDGET,
        ),
    )
    .await;
    if !output.is_usable() {
        return Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "RPC output unavailable",
        ));
    }
    let terminal = terminal_response(result, sent);
    let succeeded = matches!(terminal, Response::Result { .. });
    timeout_at(deadline, output.send(&Frame::Control(terminal)))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "RPC output deadline"))??;
    Ok(succeeded)
}

async fn exchange<R, W, S, C, F>(
    input: &mut R,
    output: &mut Writer<W>,
    connect: C,
    sent: &mut bool,
    deadline: Instant,
) -> Result<Response, ErrorCode>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    S: AsyncRead + AsyncWrite + Unpin,
    C: FnOnce() -> F,
    F: Future<Output = io::Result<S>>,
{
    let request = runner_rpc_proto::read_request(input)
        .await
        .map_err(|_| ErrorCode::InvalidRequest)?;
    let stream = dispatch_request(request, connect, sent, deadline, MAX_DURATION_MS).await?;
    let (read, write) = tokio::io::split(stream);
    let send = async {
        let mut reader = Reader::input(input);
        let mut writer = Writer::input(write);
        while let Some(frame) = reader.next().await.map_err(|_| ErrorCode::InvalidRequest)? {
            writer
                .send(&frame)
                .await
                .map_err(|_| ErrorCode::Transport)?;
        }
        Ok::<_, ErrorCode>(())
    };
    let receive = async {
        let mut reader = Reader::responses(read);
        let mut terminal = None;
        while let Some(frame) = reader.next().await.map_err(|error| {
            if error.kind() == io::ErrorKind::InvalidData {
                ErrorCode::Protocol
            } else {
                ErrorCode::Transport
            }
        })? {
            match frame {
                Frame::Control(response) if response.is_terminal() => terminal = Some(response),
                frame => output
                    .send(&frame)
                    .await
                    .map_err(|_| ErrorCode::Transport)?,
            }
        }
        terminal.ok_or(ErrorCode::Protocol)
    };
    tokio::pin!(receive);
    tokio::select! {
        // An explicit terminal ends input work, including an indefinitely quiet
        // producer. Business success still belongs to the consumer, not us.
        biased;
        result = &mut receive => result,
        result = send => { result?; receive.await }
    }
}
