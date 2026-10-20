//! In-process NBD request dispatch.
//!
//! [`dispatch`] owns one Unix socket connection passed to the kernel NBD device,
//! decodes NBD requests, applies them through [`crate::cow_io::CowIo`], and writes
//! NBD replies back to the kernel.

use std::io::IoSlice;
#[cfg(test)]
use std::num::NonZeroUsize;
use std::os::unix::io::{FromRawFd, IntoRawFd, OwnedFd};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio_util::sync::CancellationToken;

use crate::cow_io::CowIo;
use crate::error::{NbdCowError, Result};
use crate::protocol_impl::{self as protocol, Command, NbdReply, NbdRequest, REQUEST_HEADER_SIZE};

/// Maximum allowed request length (32 MB). Requests exceeding this are rejected
/// with an I/O error to prevent OOM from malformed requests.
/// Together with `CowIo`'s pre-write flush, default 4 MiB threshold and 4096-byte
/// blocks, this bounds retained COW payload at 36 MiB, even for unaligned writes.
/// Per-connection request buffers, map overhead and the dirty bitmap are separate.
const MAX_REQUEST_LENGTH: u32 = 32 * 1024 * 1024;

/// Maximum reusable payload buffer capacity retained between requests.
/// Larger legal requests use temporary buffers to avoid long-lived 32 MB buffers.
const MAX_REUSABLE_PAYLOAD_LENGTH: usize = 1024 * 1024;

#[derive(Clone, Copy)]
enum IoOutcome {
    Complete,
    Shutdown,
}

#[derive(Clone, Copy)]
enum HandlerOutcome {
    Continue,
    Shutdown,
}

#[derive(Clone, Copy)]
enum ReadContext {
    Header,
    WritePayload { handle: u64 },
    OversizedDiscard { handle: u64 },
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DispatchReadEventKind {
    WritePayload,
    OversizedDiscard,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DispatchReadEvent {
    kind: DispatchReadEventKind,
    handle: u64,
}

#[cfg(test)]
impl DispatchReadEvent {
    fn from_context(context: ReadContext) -> Option<Self> {
        match context {
            ReadContext::Header => None,
            ReadContext::WritePayload { handle } => Some(Self {
                kind: DispatchReadEventKind::WritePayload,
                handle,
            }),
            ReadContext::OversizedDiscard { handle } => Some(Self {
                kind: DispatchReadEventKind::OversizedDiscard,
                handle,
            }),
        }
    }
}

#[derive(Clone)]
struct DispatchReadObserver {
    #[cfg(test)]
    sender: Option<tokio::sync::mpsc::UnboundedSender<DispatchReadEvent>>,
}

impl DispatchReadObserver {
    fn none() -> Self {
        Self {
            #[cfg(test)]
            sender: None,
        }
    }

    #[cfg(test)]
    fn new(sender: tokio::sync::mpsc::UnboundedSender<DispatchReadEvent>) -> Self {
        Self {
            sender: Some(sender),
        }
    }

    fn notify_partial_read(&self, context: ReadContext) {
        #[cfg(test)]
        {
            if let Some(sender) = &self.sender
                && let Some(event) = DispatchReadEvent::from_context(context)
            {
                let _ = sender.send(event);
            }
        }
        #[cfg(not(test))]
        {
            match context {
                ReadContext::Header => {}
                ReadContext::WritePayload { handle } | ReadContext::OversizedDiscard { handle } => {
                    let _ = handle;
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
struct DispatchWriteLimit {
    #[cfg(test)]
    max_bytes: Option<NonZeroUsize>,
}

impl DispatchWriteLimit {
    fn none() -> Self {
        Self {
            #[cfg(test)]
            max_bytes: None,
        }
    }

    #[cfg(test)]
    fn new(max_bytes: NonZeroUsize) -> Self {
        Self {
            max_bytes: Some(max_bytes),
        }
    }

    #[cfg(test)]
    fn apply<'a>(&self, buffers: &'a [IoSlice<'_>]) -> Vec<IoSlice<'a>> {
        let mut remaining = self.max_bytes.map_or(usize::MAX, NonZeroUsize::get);
        let mut limited = Vec::with_capacity(buffers.len());
        for buffer in buffers {
            if remaining == 0 {
                break;
            }
            let len = buffer.len().min(remaining);
            limited.push(IoSlice::new(&buffer[..len]));
            remaining -= len;
        }
        limited
    }
}

/// Run the NBD dispatch loop on a Unix stream.
///
/// Reads NBD requests from the socket, dispatches to the COW layer,
/// and sends replies back. Handles graceful shutdown via the cancellation token.
pub async fn dispatch(socket_fd: OwnedFd, cow: CowIo, shutdown: CancellationToken) -> Result<()> {
    dispatch_with_observers(
        socket_fd,
        cow,
        shutdown,
        DispatchReadObserver::none(),
        DispatchWriteLimit::none(),
    )
    .await
}

async fn dispatch_with_observers(
    socket_fd: OwnedFd,
    cow: CowIo,
    shutdown: CancellationToken,
    read_observer: DispatchReadObserver,
    write_limit: DispatchWriteLimit,
) -> Result<()> {
    let raw_fd = socket_fd.into_raw_fd();
    let std_stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(raw_fd) };
    std_stream.set_nonblocking(true)?;
    let stream = UnixStream::from_std(std_stream)?;

    let (mut reader, mut writer) = stream.into_split();

    let mut header_buf = [0u8; REQUEST_HEADER_SIZE];
    let mut payload_buf = Vec::with_capacity(crate::BLOCK_SIZE);

    loop {
        match read_exact_or_shutdown(
            &mut reader,
            &mut header_buf,
            &shutdown,
            ReadContext::Header,
            &read_observer,
        )
        .await
        {
            Ok(IoOutcome::Complete) => {}
            Ok(IoOutcome::Shutdown) => {
                sync_cow_on_shutdown(&cow).await?;
                return Ok(());
            }
            Err(NbdCowError::Io(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                return Ok(());
            }
            Err(e) => return Err(e),
        }

        let request = protocol::parse_request(&header_buf)?;

        let outcome = match request.command {
            Command::Read => {
                handle_read(
                    &request,
                    &cow,
                    &mut writer,
                    &mut payload_buf,
                    &shutdown,
                    write_limit,
                )
                .await?
            }
            Command::Write => {
                handle_write(
                    &request,
                    &mut reader,
                    &cow,
                    &mut writer,
                    &mut payload_buf,
                    &shutdown,
                    &read_observer,
                )
                .await?
            }
            Command::Flush => handle_flush(&request, &cow, &mut writer, &shutdown).await?,
            Command::Trim => handle_trim(&request, &mut writer, &shutdown).await?,
            Command::Disconnect => {
                sync_cow_on_shutdown(&cow).await?;
                return Ok(());
            }
        };

        if let HandlerOutcome::Shutdown = outcome {
            sync_cow_on_shutdown(&cow).await?;
            return Ok(());
        }
    }
}

async fn sync_cow_on_shutdown(cow: &CowIo) -> Result<()> {
    cow.sync().await
}

fn handler_outcome(outcome: IoOutcome) -> HandlerOutcome {
    match outcome {
        IoOutcome::Complete => HandlerOutcome::Continue,
        IoOutcome::Shutdown => HandlerOutcome::Shutdown,
    }
}

async fn read_exact_or_shutdown(
    reader: &mut tokio::net::unix::OwnedReadHalf,
    buf: &mut [u8],
    shutdown: &CancellationToken,
    context: ReadContext,
    read_observer: &DispatchReadObserver,
) -> Result<IoOutcome> {
    let mut filled = 0usize;
    while filled < buf.len() {
        let dest = buf.get_mut(filled..).ok_or_else(|| {
            NbdCowError::Io(std::io::Error::other("read buffer slice out of bounds"))
        })?;
        tokio::select! {
            biased;
            () = shutdown.cancelled() => {
                return Ok(IoOutcome::Shutdown);
            }
            result = reader.read(dest) => {
                let count = result?;
                if count == 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "failed to fill whole buffer",
                    ).into());
                }
                filled += count;
                if filled < buf.len() {
                    read_observer.notify_partial_read(context);
                }
            }
        }
    }
    Ok(IoOutcome::Complete)
}

async fn write_all_or_shutdown(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    mut buf: &[u8],
    shutdown: &CancellationToken,
) -> Result<IoOutcome> {
    while !buf.is_empty() {
        tokio::select! {
            biased;
            () = shutdown.cancelled() => {
                return Ok(IoOutcome::Shutdown);
            }
            result = writer.write(buf) => {
                let count = result?;
                if count == 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WriteZero,
                        "failed to write whole buffer",
                    ).into());
                }
                buf = buf.get(count..).ok_or_else(|| {
                    NbdCowError::Io(std::io::Error::other("write buffer slice out of bounds"))
                })?;
            }
        }
    }
    Ok(IoOutcome::Complete)
}

async fn write_all_vectored_or_shutdown(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    header: &[u8],
    payload: &[u8],
    shutdown: &CancellationToken,
    write_limit: DispatchWriteLimit,
) -> Result<IoOutcome> {
    let mut write_slices = [IoSlice::new(header), IoSlice::new(payload)];
    let mut remaining = write_slices.as_mut_slice();
    #[cfg(not(test))]
    let _ = write_limit;
    while !remaining.is_empty() {
        #[cfg(test)]
        let limited = write_limit.apply(remaining);
        #[cfg(test)]
        let buffers = limited.as_slice();
        #[cfg(not(test))]
        let buffers: &[IoSlice<'_>] = remaining;
        let count = tokio::select! {
            biased;
            () = shutdown.cancelled() => {
                return Ok(IoOutcome::Shutdown);
            }
            result = writer.write_vectored(buffers) => result?,
        };
        if count == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "failed to write whole buffer",
            )
            .into());
        }
        IoSlice::advance_slices(&mut remaining, count);
    }
    Ok(IoOutcome::Complete)
}

async fn handle_read(
    request: &NbdRequest,
    cow: &CowIo,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    payload_buf: &mut Vec<u8>,
    shutdown: &CancellationToken,
    write_limit: DispatchWriteLimit,
) -> Result<HandlerOutcome> {
    if request.length > MAX_REQUEST_LENGTH {
        return send_error_reply(writer, request.handle, libc::EIO as u32, shutdown)
            .await
            .map(handler_outcome);
    }
    let len = request.length as usize;
    if len <= MAX_REUSABLE_PAYLOAD_LENGTH {
        resize_reusable_payload(payload_buf, len);
        let result = read_and_reply(request, cow, writer, payload_buf, shutdown, write_limit).await;
        reset_reusable_payload_if_oversized(payload_buf);
        result
    } else {
        let mut data = vec![0u8; len];
        read_and_reply(request, cow, writer, &mut data, shutdown, write_limit).await
    }
}

fn resize_reusable_payload(payload_buf: &mut Vec<u8>, len: usize) {
    debug_assert!(len <= MAX_REUSABLE_PAYLOAD_LENGTH);
    if payload_buf.capacity() < len {
        *payload_buf = vec![0u8; len];
    } else {
        payload_buf.resize(len, 0);
    }
}

fn reset_reusable_payload_if_oversized(payload_buf: &mut Vec<u8>) {
    if payload_buf.capacity() > MAX_REUSABLE_PAYLOAD_LENGTH {
        *payload_buf = Vec::with_capacity(crate::BLOCK_SIZE);
    }
}

async fn read_and_reply(
    request: &NbdRequest,
    cow: &CowIo,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    data: &mut Vec<u8>,
    shutdown: &CancellationToken,
    write_limit: DispatchWriteLimit,
) -> Result<HandlerOutcome> {
    let read_buffer = std::mem::take(data);
    match cow.read(request.offset, read_buffer).await {
        Ok(read_buffer) => {
            *data = read_buffer;
        }
        Err(e) => {
            tracing::warn!(
                offset = request.offset,
                len = request.length,
                "read error: {e}"
            );
            return send_error_reply(writer, request.handle, libc::EIO as u32, shutdown)
                .await
                .map(handler_outcome);
        }
    };

    let reply = success_reply(request.handle);
    let reply_buf = protocol::serialize_reply(&reply);
    if data.is_empty() {
        write_all_or_shutdown(writer, &reply_buf, shutdown)
            .await
            .map(handler_outcome)
    } else {
        write_all_vectored_or_shutdown(writer, &reply_buf, data.as_slice(), shutdown, write_limit)
            .await
            .map(handler_outcome)
    }
}

async fn handle_write(
    request: &NbdRequest,
    reader: &mut tokio::net::unix::OwnedReadHalf,
    cow: &CowIo,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    payload_buf: &mut Vec<u8>,
    shutdown: &CancellationToken,
    read_observer: &DispatchReadObserver,
) -> Result<HandlerOutcome> {
    if request.length > MAX_REQUEST_LENGTH {
        // Must consume the payload to keep the protocol stream in sync
        if let IoOutcome::Shutdown = discard_bytes(
            reader,
            request.length as u64,
            shutdown,
            request.handle,
            read_observer,
        )
        .await?
        {
            return Ok(HandlerOutcome::Shutdown);
        }
        return send_error_reply(writer, request.handle, libc::EIO as u32, shutdown)
            .await
            .map(handler_outcome);
    }
    let len = request.length as usize;
    if len <= MAX_REUSABLE_PAYLOAD_LENGTH {
        resize_reusable_payload(payload_buf, len);
        let result = read_and_apply_write(
            request,
            reader,
            cow,
            writer,
            payload_buf,
            shutdown,
            read_observer,
        )
        .await;
        reset_reusable_payload_if_oversized(payload_buf);
        result
    } else {
        let mut data = vec![0u8; len];
        read_and_apply_write(
            request,
            reader,
            cow,
            writer,
            &mut data,
            shutdown,
            read_observer,
        )
        .await
    }
}

async fn read_and_apply_write(
    request: &NbdRequest,
    reader: &mut tokio::net::unix::OwnedReadHalf,
    cow: &CowIo,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    data: &mut Vec<u8>,
    shutdown: &CancellationToken,
    read_observer: &DispatchReadObserver,
) -> Result<HandlerOutcome> {
    if let IoOutcome::Shutdown = read_exact_or_shutdown(
        reader,
        data.as_mut_slice(),
        shutdown,
        ReadContext::WritePayload {
            handle: request.handle,
        },
        read_observer,
    )
    .await?
    {
        return Ok(HandlerOutcome::Shutdown);
    }

    let write_buffer = std::mem::take(data);
    match cow.write(request.offset, write_buffer).await {
        Ok(write_buffer) => {
            *data = write_buffer;
        }
        Err(e) => {
            tracing::warn!(
                offset = request.offset,
                len = request.length,
                "write or flush error: {e}"
            );
            return send_error_reply(writer, request.handle, libc::EIO as u32, shutdown)
                .await
                .map(handler_outcome);
        }
    }

    send_success_reply(writer, request.handle, shutdown)
        .await
        .map(handler_outcome)
}

async fn handle_flush(
    request: &NbdRequest,
    cow: &CowIo,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    shutdown: &CancellationToken,
) -> Result<HandlerOutcome> {
    if let Err(e) = cow.sync().await {
        tracing::warn!("sync error: {e}");
        return send_error_reply(writer, request.handle, libc::EIO as u32, shutdown)
            .await
            .map(handler_outcome);
    }

    send_success_reply(writer, request.handle, shutdown)
        .await
        .map(handler_outcome)
}

async fn handle_trim(
    request: &NbdRequest,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    shutdown: &CancellationToken,
) -> Result<HandlerOutcome> {
    // Trim is a no-op for now (COW file is sparse, unused blocks are holes)
    send_success_reply(writer, request.handle, shutdown)
        .await
        .map(handler_outcome)
}

fn success_reply(handle: u64) -> NbdReply {
    NbdReply { error: 0, handle }
}

async fn send_reply(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    reply: &NbdReply,
    shutdown: &CancellationToken,
) -> Result<IoOutcome> {
    let buf = protocol::serialize_reply(reply);
    write_all_or_shutdown(writer, &buf, shutdown).await
}

async fn send_success_reply(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    handle: u64,
    shutdown: &CancellationToken,
) -> Result<IoOutcome> {
    send_reply(writer, &success_reply(handle), shutdown).await
}

async fn send_error_reply(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    handle: u64,
    error: u32,
    shutdown: &CancellationToken,
) -> Result<IoOutcome> {
    send_reply(writer, &NbdReply { error, handle }, shutdown).await
}

/// Discard `n` bytes from the reader to keep the protocol stream in sync.
async fn discard_bytes(
    reader: &mut tokio::net::unix::OwnedReadHalf,
    mut remaining: u64,
    shutdown: &CancellationToken,
    handle: u64,
    read_observer: &DispatchReadObserver,
) -> Result<IoOutcome> {
    let mut buf = [0u8; 4096];
    while remaining > 0 {
        let to_read = (remaining as usize).min(buf.len());
        let dest = buf
            .get_mut(..to_read)
            .ok_or_else(|| NbdCowError::Io(std::io::Error::other("discard slice error")))?;
        if let IoOutcome::Shutdown = read_exact_or_shutdown(
            reader,
            dest,
            shutdown,
            ReadContext::OversizedDiscard { handle },
            read_observer,
        )
        .await?
        {
            return Ok(IoOutcome::Shutdown);
        }
        remaining -= to_read as u64;
    }
    Ok(IoOutcome::Complete)
}

#[cfg(test)]
mod tests;
