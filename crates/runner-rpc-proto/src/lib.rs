//! Bounded, one-request Guest-to-Runner RPC with opaque business JSON.
//!
//! Each wire frame is a big-endian u32 length followed by strict envelope JSON.
//! Method dispatch, authority checks and business outcomes belong to consumers.

pub mod stream;

use std::io;

use serde::{Deserialize, Deserializer, Serialize, de::DeserializeOwned};
use serde_json::value::RawValue;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const VERSION: u16 = 1;
pub const VSOCK_PORT: u32 = 52001;
pub const HOST_CID: u32 = 2;
pub const MAX_METHOD_BYTES: usize = 64;
pub const MAX_REQUEST_BYTES: usize = 400 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 24 * 1024;
/// Includes every length header and reserves room for one maximum terminal.
pub const MAX_RESPONSE_STREAM_BYTES: usize = 4 * 1024 * 1024;
const HEADER_BYTES: usize = 4;

/// A method is a routing label, not authority or an executable/endpoint path.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u16,
    pub method: String,
    /// Must be an object. Its fields and values are not interpreted here.
    pub params: Box<RawValue>,
    /// Bundled-helper remaining wall-time budget at transmission. The host
    /// treats this as untrusted and clamps it to its own maximum deadline.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub remaining_ms: Option<u64>,
}

impl Request {
    pub fn validate(&self) -> io::Result<()> {
        if self.version != VERSION
            || self.method.is_empty()
            || self.method.len() > MAX_METHOD_BYTES
            || !self
                .method
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            || !self.params.get().starts_with('{')
        {
            return Err(invalid("invalid RPC request"));
        }
        Ok(())
    }
}

pub fn parse_request(bytes: &[u8]) -> io::Result<Request> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(invalid("RPC request too large"));
    }
    let request: Request = parse(bytes)?;
    request.validate()?;
    Ok(request)
}

/// Read the first complete request frame without waiting for transport EOF.
///
/// A connection carries one operation: callers must dispatch at most once and
/// then drop the stream after all handler work. Bytes after this frame are not
/// part of the request and must never become another operation. Do not drain
/// them: a guest may keep sending indefinitely. JSON inside the frame is strict.
/// After cancellation or failure, drop the stream rather than resuming a frame.
pub async fn read_request(reader: &mut (impl AsyncRead + Unpin)) -> io::Result<Request> {
    let bytes = read_frame(reader, MAX_REQUEST_BYTES)
        .await?
        .ok_or_else(|| invalid("missing RPC request"))?;
    parse_request(&bytes)
}

/// Write once and never retry on failure. The caller may half-close its stream,
/// but only the frame length defines completion: Firecracker does not forward
/// guest send-half shutdown as EOF on the host stream.
pub async fn write_request(
    writer: &mut (impl AsyncWrite + Unpin),
    request: &Request,
) -> io::Result<()> {
    request.validate()?;
    let bytes = encode(request, MAX_REQUEST_BYTES)?;
    write_frame(writer, &bytes).await
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    UnknownMethod,
    Unavailable,
    Protocol,
    Transport,
    TimedOut,
    ResourceExhausted,
}

/// Missing a reply after transmission is not proof of non-execution.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    /// Known locally before transmission, or rejected before host dispatch.
    NotDispatched,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    Event {
        data: Box<RawValue>,
    },
    /// RPC completion, not business success. Consumers must interpret data.
    Result {
        data: Box<RawValue>,
    },
    Error {
        code: ErrorCode,
        delivery: Delivery,
    },
}

// A derived internally tagged deserializer buffers JSON as semantic values,
// which cannot preserve RawValue. Decode the flat envelope directly instead.
impl<'de> Deserialize<'de> for Response {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case")]
        enum Kind {
            Event,
            Result,
            Error,
        }

        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Envelope {
            #[serde(rename = "type")]
            kind: Kind,
            #[serde(default, deserialize_with = "present")]
            data: Option<Box<RawValue>>,
            #[serde(default, deserialize_with = "present")]
            code: Option<ErrorCode>,
            #[serde(default, deserialize_with = "present")]
            delivery: Option<Delivery>,
        }

        let envelope = Envelope::deserialize(deserializer)?;
        match (
            envelope.kind,
            envelope.data,
            envelope.code,
            envelope.delivery,
        ) {
            (Kind::Event, Some(data), None, None) => Ok(Self::Event { data }),
            (Kind::Result, Some(data), None, None) => Ok(Self::Result { data }),
            (Kind::Error, None, Some(code), Some(delivery)) => Ok(Self::Error { code, delivery }),
            _ => Err(serde::de::Error::custom("invalid RPC response envelope")),
        }
    }
}

// Distinguish an absent field from a present JSON null (valid only as raw data).
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

impl Response {
    pub fn is_terminal(&self) -> bool {
        !matches!(self, Self::Event { .. })
    }

    pub fn error(code: ErrorCode, delivery: Delivery) -> Self {
        Self::Error { code, delivery }
    }

    /// Compact only JSON whitespace outside strings. Raw payload keys, numeric
    /// tokens and escapes stay intact, including duplicate keys for the handler
    /// to reject if its schema requires uniqueness. Never normalize via Value.
    pub fn to_ndjson(&self) -> io::Result<Vec<u8>> {
        let bytes = encode(self, MAX_RESPONSE_BYTES)?;
        let mut line = Vec::with_capacity(bytes.len() + 1);
        let mut in_string = false;
        let mut escaped = false;
        for byte in bytes {
            if in_string {
                line.push(byte);
                if escaped {
                    escaped = false;
                } else if byte == b'\\' {
                    escaped = true;
                } else if byte == b'"' {
                    in_string = false;
                }
            } else if byte == b'"' {
                in_string = true;
                line.push(byte);
            } else if !byte.is_ascii_whitespace() {
                line.push(byte);
            }
        }
        line.push(b'\n');
        Ok(line)
    }
}

#[derive(Clone, Default)]
struct ResponseState {
    emitted_event: bool,
    terminal: bool,
    bytes: usize,
}

impl ResponseState {
    fn observe(&mut self, response: &Response, frame_bytes: usize) -> io::Result<()> {
        if self.terminal {
            return Err(invalid("RPC response after terminal"));
        }
        if matches!(
            response,
            Response::Error {
                delivery: Delivery::NotDispatched,
                ..
            }
        ) && self.emitted_event
        {
            return Err(invalid("RPC not-dispatched error after event"));
        }
        let reserve = if response.is_terminal() {
            0
        } else {
            MAX_RESPONSE_BYTES + HEADER_BYTES
        };
        if frame_bytes > MAX_RESPONSE_STREAM_BYTES - self.bytes - reserve {
            return Err(invalid("RPC response stream limit exceeded"));
        }
        self.bytes += frame_bytes;
        self.terminal = response.is_terminal();
        self.emitted_event |= !self.terminal;
        Ok(())
    }
}

/// Stateful bounded response reader. Call through EOF to verify terminal uniqueness.
pub struct ResponseReader<R> {
    reader: R,
    state: ResponseState,
    failed: bool,
}

impl<R: AsyncRead + Unpin> ResponseReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            state: ResponseState::default(),
            failed: false,
        }
    }

    pub async fn next(&mut self) -> io::Result<Option<Response>> {
        if self.failed {
            return Err(invalid("RPC response reader failed"));
        }
        // Cancellation of a partial frame must not allow resuming mid-frame.
        self.failed = true;
        let max = MAX_RESPONSE_BYTES
            .min((MAX_RESPONSE_STREAM_BYTES - self.state.bytes).saturating_sub(HEADER_BYTES));
        let Some(bytes) = read_frame(&mut self.reader, max).await? else {
            if !self.state.terminal {
                return Err(invalid("missing RPC terminal response"));
            }
            self.failed = false;
            return Ok(None);
        };
        let response = parse(&bytes)?;
        self.state.observe(&response, bytes.len() + HEADER_BYTES)?;
        self.failed = false;
        Ok(Some(response))
    }
}

/// Handler-side writer. A terminal shuts down the write side, but does not
/// release the owned stream/reservation. Keep it through all handler work and
/// observe lifecycle cancellation even while not doing guest I/O.
pub struct ResponseWriter<W> {
    writer: W,
    state: ResponseState,
    failed: bool,
}

impl<W: AsyncWrite + Unpin> ResponseWriter<W> {
    pub fn new(writer: W) -> Self {
        Self {
            writer,
            state: ResponseState::default(),
            failed: false,
        }
    }

    pub async fn send(&mut self, response: &Response) -> io::Result<()> {
        if self.failed {
            return Err(invalid("RPC response writer failed"));
        }
        // Local shape/size rejection does not poison a stream we never touched.
        let bytes = encode(response, MAX_RESPONSE_BYTES)?;
        let mut next = self.state.clone();
        next.observe(response, bytes.len() + HEADER_BYTES)?;
        self.failed = true;
        write_frame(&mut self.writer, &bytes).await?;
        if next.terminal {
            self.writer.shutdown().await?;
        }
        self.state = next;
        self.failed = false;
        Ok(())
    }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn parse<T: DeserializeOwned>(bytes: &[u8]) -> io::Result<T> {
    // Serde structs also accept positional arrays; wire envelopes must be objects.
    if bytes.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
        return Err(invalid("RPC envelope must be an object"));
    }
    // Never expose serde's untrusted field/value excerpts in diagnostics.
    serde_json::from_slice(bytes).map_err(|_| invalid("invalid RPC frame JSON"))
}

async fn read_frame(
    reader: &mut (impl AsyncRead + Unpin),
    max: usize,
) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; HEADER_BYTES];
    let (first, rest) = header.split_at_mut(1);
    if reader.read(first).await? == 0 {
        return Ok(None);
    }
    reader.read_exact(rest).await?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > max {
        return Err(invalid("invalid RPC frame length"));
    }
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes).await?;
    Ok(Some(bytes))
}

fn encode(value: &impl Serialize, max: usize) -> io::Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value).map_err(|_| invalid("invalid RPC frame"))?;
    if bytes.len() > max {
        return Err(invalid("RPC frame too large"));
    }
    Ok(bytes)
}

async fn write_frame(writer: &mut (impl AsyncWrite + Unpin), bytes: &[u8]) -> io::Result<()> {
    let size = u32::try_from(bytes.len()).map_err(|_| invalid("RPC frame too large"))?;
    writer.write_all(&size.to_be_bytes()).await?;
    writer.write_all(bytes).await?;
    writer.flush().await
}
