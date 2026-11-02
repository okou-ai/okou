//! Credit-bounded zstd input for the existing file-write worker.
use crate::writer::GuestWriter;
use guest_control_proto::{
    BorrowedRawMessage, MSG_WRITE_FILE_STREAM_CREDIT, MSG_WRITE_FILE_STREAM_END,
};
use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

const BLOCK: usize = 64 * 1024;
const WINDOW: usize = 4;
const MAX_ENCODED: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct Streams(Mutex<Option<Ingress>>);

struct Ingress {
    seq: u32,
    sender: mpsc::SyncSender<Option<Vec<u8>>>,
    credits: Arc<AtomicUsize>,
    bytes: usize,
    expected_bytes: Option<usize>,
    ended: bool,
}

pub(crate) struct Input {
    receiver: mpsc::Receiver<Option<Vec<u8>>>,
    current: io::Cursor<Vec<u8>>,
    consumed_frame: bool,
    credits: Arc<AtomicUsize>,
    seq: u32,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    pub(crate) stop: Arc<AtomicBool>,
    deadline: Instant,
    ended: bool,
}

impl Streams {
    pub(crate) fn begin(
        &self,
        seq: u32,
        writer: GuestWriter,
        connection_cancel: Arc<AtomicBool>,
        expected_bytes: Option<usize>,
    ) -> io::Result<Input> {
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some() {
            return Err(io::Error::other("stream already active"));
        }
        let (sender, receiver) = mpsc::sync_channel(WINDOW + 1); // one reserved EOF slot
        let credits = Arc::new(AtomicUsize::new(WINDOW));
        *slot = Some(Ingress {
            seq,
            sender,
            credits: Arc::clone(&credits),
            bytes: 0,
            expected_bytes,
            ended: false,
        });
        Ok(Input {
            receiver,
            current: io::Cursor::new(Vec::new()),
            consumed_frame: false,
            credits,
            seq,
            writer,
            connection_cancel,
            stop: Arc::new(AtomicBool::new(false)),
            deadline: Instant::now() + Duration::from_secs(30),
            ended: false,
        })
    }

    pub(crate) fn accept(&self, msg: BorrowedRawMessage<'_>) -> io::Result<()> {
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let input = slot
            .as_mut()
            .ok_or_else(|| io::Error::other("no active stream"))?;
        if input.seq != msg.seq || input.ended {
            return Err(io::Error::other("stream sequence or end mismatch"));
        }
        if msg.msg_type == MSG_WRITE_FILE_STREAM_END {
            if !msg.payload.is_empty() {
                return Err(io::Error::other("nonempty stream end"));
            }
            if input
                .expected_bytes
                .is_some_and(|expected| input.bytes != expected)
            {
                return Err(io::Error::other("encoded source size mismatch"));
            }
            input.ended = true;
            return input.sender.try_send(None).map_err(io::Error::other);
        }
        if msg.payload.is_empty() || msg.payload.len() > BLOCK {
            return Err(io::Error::other("invalid data frame size"));
        }
        input
            .credits
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1))
            .map_err(|_| io::Error::other("stream exceeded credit"))?;
        input.bytes += msg.payload.len();
        if input.bytes > input.expected_bytes.unwrap_or(MAX_ENCODED) {
            return Err(io::Error::other("encoded stream exceeds request bound"));
        }
        input
            .sender
            .try_send(Some(msg.payload.to_vec()))
            .map_err(io::Error::other)
    }

    pub(crate) fn finish(&self, seq: u32) {
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|s| s.seq == seq) {
            slot.take();
        }
    }
}

impl Input {
    pub(crate) fn grant_initial(&self) -> io::Result<()> {
        self.credit(WINDOW as u8)
    }
    fn credit(&self, count: u8) -> io::Result<()> {
        let frame = guest_control_proto::encode(MSG_WRITE_FILE_STREAM_CREDIT, self.seq, &[count])
            .map_err(io::Error::other)?;
        self.writer.write_frame(&frame)
    }
}

impl Read for Input {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        loop {
            if self.connection_cancel.load(Ordering::Acquire) || self.stop.load(Ordering::Acquire) {
                return Err(io::Error::other("stream cancelled"));
            }
            let count = self.current.read(out)?;
            if count != 0 {
                return Ok(count);
            }
            if self.consumed_frame {
                self.consumed_frame = false;
                self.credits.fetch_add(1, Ordering::AcqRel);
                self.credit(1)?;
            }
            if self.ended {
                return Ok(0);
            }
            if Instant::now() >= self.deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "stream input timeout",
                ));
            }
            match self.receiver.recv_timeout(Duration::from_millis(10)) {
                Ok(Some(bytes)) => {
                    self.current = io::Cursor::new(bytes);
                    self.consumed_frame = true;
                }
                Ok(None) => self.ended = true,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(io::Error::other("stream input disconnected"));
                }
            }
        }
    }
}

pub(crate) fn validate_begin(payload: &[u8]) -> Result<(), guest_control_proto::ProtocolError> {
    decode_begin(payload).map(|_| ())
}

pub(crate) fn decode_begin(
    payload: &[u8],
) -> Result<StreamBegin<'_>, guest_control_proto::ProtocolError> {
    use guest_control_proto::ProtocolError;
    let [codec, a, b, c, d, rest @ ..] = payload else {
        return Err(ProtocolError::InvalidPayload("invalid zstd stream begin"));
    };
    let size = u32::from_be_bytes([*a, *b, *c, *d]);
    let (codec, metadata) = match codec {
        1 => (StreamCodec::Zstd, rest),
        2 => {
            let [a, b, c, d, rest @ ..] = rest else {
                return Err(ProtocolError::InvalidPayload("invalid source stream begin"));
            };
            let encoded_size = u32::from_be_bytes([*a, *b, *c, *d]) as usize;
            if encoded_size == 0 || encoded_size > guest_control_proto::MAX_ZSTD_SOURCE_BYTES {
                return Err(ProtocolError::InvalidPayload(
                    "source encoded length too large/empty",
                ));
            }
            let [a, b, c, d, metadata @ ..] = rest else {
                return Err(ProtocolError::InvalidPayload("missing source CRC"));
            };
            (
                StreamCodec::ZstdSource {
                    encoded_size,
                    crc32: u32::from_be_bytes([*a, *b, *c, *d]),
                },
                metadata,
            )
        }
        _ => return Err(ProtocolError::InvalidPayload("invalid zstd stream codec")),
    };
    let raw_limit = match codec {
        StreamCodec::Zstd => 15 * 1024 * 1024,
        StreamCodec::ZstdSource { .. } => guest_control_proto::MAX_ZSTD_SOURCE_BYTES,
    };
    if size as usize > raw_limit {
        return Err(ProtocolError::InvalidPayload("stream raw length too large"));
    }
    let (path, content, sudo, append, private) = guest_control_proto::decode_write_file(metadata)?;
    if !content.is_empty() || private || (matches!(codec, StreamCodec::ZstdSource { .. }) && append)
    {
        return Err(ProtocolError::InvalidPayload(
            "unsupported stream flags/content",
        ));
    }
    Ok(StreamBegin {
        raw_size: size,
        path,
        sudo,
        append,
        codec,
    })
}

pub(crate) struct StreamBegin<'a> {
    pub(crate) raw_size: u32,
    pub(crate) path: &'a str,
    pub(crate) sudo: bool,
    pub(crate) append: bool,
    pub(crate) codec: StreamCodec,
}

pub(crate) enum StreamCodec {
    Zstd,
    ZstdSource { encoded_size: usize, crc32: u32 },
}

impl StreamCodec {
    pub(crate) fn encoded_size(&self) -> Option<usize> {
        match self {
            Self::Zstd => None,
            Self::ZstdSource { encoded_size, .. } => Some(*encoded_size),
        }
    }
}

#[cfg(test)]
mod tests;
