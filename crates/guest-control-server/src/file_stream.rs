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
            input.ended = true;
            return input.sender.try_send(None).map_err(io::Error::other);
        }
        if msg.payload.is_empty() || msg.payload.len() > BLOCK {
            return Err(io::Error::other("invalid data frame size"));
        }
        input
            .credits
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1))
            .map_err(|_| io::Error::other("stream exceeded credit"))?;
        input.bytes += msg.payload.len();
        if input.bytes > MAX_ENCODED {
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
) -> Result<(u32, &str, bool, bool), guest_control_proto::ProtocolError> {
    use guest_control_proto::ProtocolError;
    let [1, a, b, c, d, metadata @ ..] = payload else {
        return Err(ProtocolError::InvalidPayload("invalid zstd stream begin"));
    };
    let size = u32::from_be_bytes([*a, *b, *c, *d]);
    if size > 15 * 1024 * 1024 {
        return Err(ProtocolError::InvalidPayload("stream raw length too large"));
    }
    let (path, content, sudo, append, private) = guest_control_proto::decode_write_file(metadata)?;
    if !content.is_empty() || private {
        return Err(ProtocolError::InvalidPayload(
            "unsupported stream flags/content",
        ));
    }
    Ok((size, path, sudo, append))
}

#[cfg(test)]
mod tests {
    use super::*;
    use guest_control_proto::MSG_WRITE_FILE_STREAM_DATA;
    use std::os::unix::net::UnixStream;

    #[test]
    fn unread_stream_rejects_data_beyond_its_credit_window() {
        let streams = Streams::default();
        let (writer, _peer) = UnixStream::pair().unwrap();
        let _input = streams
            .begin(
                1,
                GuestWriter::new(writer),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
        for _ in 0..WINDOW {
            streams
                .accept(BorrowedRawMessage {
                    msg_type: MSG_WRITE_FILE_STREAM_DATA,
                    seq: 1,
                    payload: b"x",
                })
                .unwrap();
        }
        let error = streams
            .accept(BorrowedRawMessage {
                msg_type: MSG_WRITE_FILE_STREAM_DATA,
                seq: 1,
                payload: b"x",
            })
            .unwrap_err();
        assert_eq!(error.to_string(), "stream exceeded credit");
    }

    #[test]
    fn full_credit_window_reserves_end_and_drains_exact_bytes() {
        let streams = Streams::default();
        let (writer, _peer) = UnixStream::pair().unwrap();
        let mut input = streams
            .begin(
                2,
                GuestWriter::new(writer),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
        for _ in 0..WINDOW {
            streams
                .accept(BorrowedRawMessage {
                    msg_type: MSG_WRITE_FILE_STREAM_DATA,
                    seq: 2,
                    payload: b"x",
                })
                .unwrap();
        }
        streams
            .accept(BorrowedRawMessage {
                msg_type: MSG_WRITE_FILE_STREAM_END,
                seq: 2,
                payload: &[],
            })
            .unwrap();
        let mut bytes = Vec::new();
        input.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, vec![b'x'; WINDOW]);
    }
}
