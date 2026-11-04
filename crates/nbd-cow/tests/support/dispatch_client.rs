use std::error::Error;
use std::io::Write as _;
use std::os::unix::io::{FromRawFd, OwnedFd};
use std::path::Path;
use std::time::Duration;

use nbd_cow::cow::CowLayer;
use nbd_cow::cow_io::CowIo;
use nbd_cow::error::Result as NbdResult;
use nbd_cow::server::dispatch;
use nbd_cow::{BLOCK_SIZE, DEFAULT_FLUSH_THRESHOLD};
use tempfile::NamedTempFile;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub type TestResult<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

const REQUEST_MAGIC: u32 = 0x2560_9513;
const REPLY_MAGIC: u32 = 0x6744_6698;
const REQUEST_HEADER_SIZE: usize = 28;
const REPLY_HEADER_SIZE: usize = 16;
const REQUEST_TYPE_COMMAND_MASK: u32 = 0x0000_FFFF;
const REQUEST_MAGIC_OFFSET: usize = 0;
const REQUEST_TYPE_OFFSET: usize = 4;
const REQUEST_HANDLE_OFFSET: usize = 8;
const REQUEST_OFFSET_FIELD_OFFSET: usize = 16;
const REQUEST_LENGTH_OFFSET: usize = 24;
const REPLY_MAGIC_OFFSET: usize = 0;
const REPLY_ERROR_OFFSET: usize = 4;
const REPLY_HANDLE_OFFSET: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum Command {
    Read = 0,
    Write = 1,
    Disconnect = 2,
    Flush = 3,
    Trim = 4,
}

#[derive(Debug, Clone)]
pub struct NbdRequest {
    request_type_flags: u32,
    command: Command,
    handle: u64,
    offset: u64,
    length: u32,
}

#[derive(Debug, Clone)]
pub struct NbdReply {
    error: u32,
    handle: u64,
}

pub struct DispatchClient {
    reader: OwnedReadHalf,
    writer: OwnedWriteHalf,
}

impl DispatchClient {
    pub async fn read(&mut self, handle: u64, offset: u64, length: u32) -> TestResult<Vec<u8>> {
        let request = request(Command::Read, handle, offset, length);
        self.send_request(&request).await?;
        let reply = self.read_reply().await?;
        assert_success(&reply, handle);
        self.read_payload(length as usize).await
    }

    pub async fn write(&mut self, handle: u64, offset: u64, data: &[u8]) -> TestResult<NbdReply> {
        let length = u32::try_from(data.len())?;
        let request = request(Command::Write, handle, offset, length);
        self.send_request(&request).await?;
        self.write_payload(data).await?;
        self.read_reply().await
    }

    pub async fn flush(&mut self, handle: u64) -> TestResult<NbdReply> {
        let request = request(Command::Flush, handle, 0, 0);
        self.send_request(&request).await?;
        self.read_reply().await
    }

    pub async fn trim(&mut self, handle: u64, offset: u64, length: u32) -> TestResult<NbdReply> {
        let request = request(Command::Trim, handle, offset, length);
        self.send_request(&request).await?;
        self.read_reply().await
    }

    pub async fn disconnect(&mut self, handle: u64) -> TestResult<()> {
        let request = request(Command::Disconnect, handle, 0, 0);
        self.send_request(&request).await
    }

    pub async fn send_request(&mut self, request: &NbdRequest) -> TestResult<()> {
        self.writer.write_all(&serialize_request(request)).await?;
        Ok(())
    }

    pub async fn write_payload(&mut self, data: &[u8]) -> TestResult<()> {
        self.writer.write_all(data).await?;
        Ok(())
    }

    pub async fn write_repeated_payload(
        &mut self,
        byte: u8,
        total: usize,
        chunk_size: usize,
    ) -> TestResult<()> {
        if total > 0 && chunk_size == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "payload chunk size must be non-zero",
            )
            .into());
        }

        if total == 0 {
            return Ok(());
        }

        let chunk = vec![byte; chunk_size.min(total)];
        let mut sent = 0usize;
        while sent < total {
            let to_send = chunk.len().min(total - sent);
            let payload = chunk
                .get(..to_send)
                .ok_or_else(|| std::io::Error::other("payload chunk slice out of bounds"))?;
            self.write_payload(payload).await?;
            sent += to_send;
        }
        Ok(())
    }

    pub async fn read_reply(&mut self) -> TestResult<NbdReply> {
        let mut reply_buf = [0u8; REPLY_HEADER_SIZE];
        self.reader.read_exact(&mut reply_buf).await?;
        let magic = read_u32_be(&reply_buf, REPLY_MAGIC_OFFSET);
        assert_eq!(magic, REPLY_MAGIC);

        Ok(NbdReply {
            error: read_u32_be(&reply_buf, REPLY_ERROR_OFFSET),
            handle: read_u64_be(&reply_buf, REPLY_HANDLE_OFFSET),
        })
    }

    pub async fn read_payload(&mut self, len: usize) -> TestResult<Vec<u8>> {
        let mut data = vec![0u8; len];
        self.reader.read_exact(&mut data).await?;
        Ok(data)
    }
}

pub fn request(command: Command, handle: u64, offset: u64, length: u32) -> NbdRequest {
    request_with_type_flags(command, handle, offset, length, 0)
}

pub fn request_with_type_flags(
    command: Command,
    handle: u64,
    offset: u64,
    length: u32,
    request_type_flags: u32,
) -> NbdRequest {
    assert_eq!(
        request_type_flags & REQUEST_TYPE_COMMAND_MASK,
        0,
        "request type flags must not overlap command bits"
    );

    NbdRequest {
        request_type_flags,
        command,
        handle,
        offset,
        length,
    }
}

pub fn assert_success(reply: &NbdReply, expected_handle: u64) {
    assert_eq!(reply.handle, expected_handle);
    assert_eq!(reply.error, 0);
}

pub fn assert_error(reply: &NbdReply, expected_handle: u64) {
    assert_eq!(reply.handle, expected_handle);
    assert_ne!(reply.error, 0);
}

pub fn assert_error_code(reply: &NbdReply, expected_handle: u64, expected_error: u32) {
    assert_eq!(reply.handle, expected_handle);
    assert_eq!(reply.error, expected_error);
}

pub fn create_test_cow(base_data: &[u8]) -> TestResult<(NamedTempFile, NamedTempFile, CowLayer)> {
    create_test_cow_with_flush_threshold(base_data, DEFAULT_FLUSH_THRESHOLD)
}

pub fn create_test_cow_with_flush_threshold(
    base_data: &[u8],
    flush_threshold: usize,
) -> TestResult<(NamedTempFile, NamedTempFile, CowLayer)> {
    let mut base = NamedTempFile::new()?;
    base.write_all(base_data)?;
    base.flush()?;

    let cow_file = NamedTempFile::new()?;
    let cow = CowLayer::new(
        base.path(),
        cow_file.path(),
        base_data.len() as u64,
        BLOCK_SIZE,
        flush_threshold,
    )?;

    Ok((base, cow_file, cow))
}

pub fn create_base_file(base_data: &[u8]) -> TestResult<NamedTempFile> {
    let mut base = NamedTempFile::new()?;
    base.write_all(base_data)?;
    base.flush()?;
    Ok(base)
}

pub fn create_cow_with_full_device(
    base: &NamedTempFile,
    flush_threshold: usize,
) -> TestResult<CowLayer> {
    let size = base.as_file().metadata()?.len();
    let cow = CowLayer::new(
        base.path(),
        Path::new("/dev/full"),
        size,
        BLOCK_SIZE,
        flush_threshold,
    )?;
    Ok(cow)
}

pub async fn spawn_dispatch(
    cow: CowIo,
) -> TestResult<(DispatchClient, JoinHandle<NbdResult<()>>, CancellationToken)> {
    let shutdown = CancellationToken::new();
    let (client, task) = spawn_dispatch_with_shutdown(cow, shutdown.clone()).await?;
    Ok((client, task, shutdown))
}

pub async fn spawn_dispatch_with_shutdown(
    cow: CowIo,
    shutdown: CancellationToken,
) -> TestResult<(DispatchClient, JoinHandle<NbdResult<()>>)> {
    let (client_fd, server_fd) = socketpair()?;

    let client_std = std::os::unix::net::UnixStream::from(client_fd);
    client_std.set_nonblocking(true)?;
    let client_stream = UnixStream::from_std(client_std)?;
    let (reader, writer) = client_stream.into_split();

    let shutdown_clone = shutdown.clone();
    let task = tokio::spawn(async move { dispatch(server_fd, cow, shutdown_clone).await });

    Ok((DispatchClient { reader, writer }, task))
}

pub async fn wait_for_dispatch(task: JoinHandle<NbdResult<()>>) -> TestResult<()> {
    tokio::time::timeout(Duration::from_secs(1), task).await???;
    Ok(())
}

fn socketpair() -> std::io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0i32; 2];
    let ret = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) };
    if ret != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

fn read_u32_be(buf: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(read_bytes(buf, offset))
}

fn read_u64_be(buf: &[u8], offset: usize) -> u64 {
    u64::from_be_bytes(read_bytes(buf, offset))
}

fn read_bytes<const N: usize>(buf: &[u8], offset: usize) -> [u8; N] {
    let mut bytes = [0u8; N];
    let copied = if let Some(slice) = offset.checked_add(N).and_then(|end| buf.get(offset..end)) {
        bytes.copy_from_slice(slice);
        true
    } else {
        false
    };
    assert!(copied, "NBD field offset must fit fixed header");
    bytes
}

fn write_u32_be(buf: &mut [u8], offset: usize, value: u32) {
    write_bytes(buf, offset, value.to_be_bytes());
}

fn write_u64_be(buf: &mut [u8], offset: usize, value: u64) {
    write_bytes(buf, offset, value.to_be_bytes());
}

fn write_bytes<const N: usize>(buf: &mut [u8], offset: usize, bytes: [u8; N]) {
    let copied = if let Some(dest) = offset
        .checked_add(N)
        .and_then(|end| buf.get_mut(offset..end))
    {
        dest.copy_from_slice(&bytes);
        true
    } else {
        false
    };
    assert!(copied, "NBD field offset must fit fixed header");
}

fn serialize_request(request: &NbdRequest) -> [u8; REQUEST_HEADER_SIZE] {
    let mut buf = [0u8; REQUEST_HEADER_SIZE];
    let request_type = request.request_type_flags | request.command as u32;

    write_u32_be(&mut buf, REQUEST_MAGIC_OFFSET, REQUEST_MAGIC);
    write_u32_be(&mut buf, REQUEST_TYPE_OFFSET, request_type);
    write_u64_be(&mut buf, REQUEST_HANDLE_OFFSET, request.handle);
    write_u64_be(&mut buf, REQUEST_OFFSET_FIELD_OFFSET, request.offset);
    write_u32_be(&mut buf, REQUEST_LENGTH_OFFSET, request.length);
    buf
}
