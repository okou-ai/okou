use std::io;

use guest_control_proto::{HEADER_SIZE, MAX_MESSAGE_SIZE, MIN_BODY_SIZE};
use tokio::io::AsyncReadExt;
use tokio::net::unix::OwnedReadHalf;

use super::Frame;

/// Read progress stays here when a control event wins the relay's select.
pub(super) struct Reader {
    stream: OwnedReadHalf,
    bytes: Vec<u8>,
}

impl Reader {
    pub(super) fn new(stream: OwnedReadHalf) -> Self {
        Self {
            stream,
            bytes: Vec::new(),
        }
    }

    pub(super) async fn next(&mut self) -> io::Result<Option<Frame>> {
        loop {
            let total = if let Some(prefix) = self.bytes.get(..HEADER_SIZE) {
                let [a, b, c, d] = prefix else {
                    return Err(io::Error::other("invalid Guest frame prefix bound"));
                };
                let length = u32::from_be_bytes([*a, *b, *c, *d]) as usize;
                if !(MIN_BODY_SIZE..=MAX_MESSAGE_SIZE).contains(&length) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Guest frame length outside protocol bounds",
                    ));
                }
                HEADER_SIZE + length
            } else {
                HEADER_SIZE
            };
            if self.bytes.len() == total && total > HEADER_SIZE {
                let bytes = std::mem::take(&mut self.bytes);
                let [_, _, _, _, message_type, a, b, c, d, ..] = bytes.as_slice() else {
                    return Err(io::Error::other("complete Guest frame missing header"));
                };
                return Ok(Some(Frame {
                    message_type: *message_type,
                    sequence: u32::from_be_bytes([*a, *b, *c, *d]),
                    bytes: bytes.into(),
                }));
            }
            // Grow only from actual bytes, never an untrusted declared length.
            let mut chunk = [0; 8192];
            let remaining = (total - self.bytes.len()).min(chunk.len());
            let buffer = chunk
                .get_mut(..remaining)
                .ok_or_else(|| io::Error::other("Guest frame read exceeded its bounded buffer"))?;
            let count = self.stream.read(buffer).await?;
            if count == 0 {
                return if self.bytes.is_empty() {
                    Ok(None)
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "truncated original Guest frame",
                    ))
                };
            }
            self.bytes.extend_from_slice(
                buffer
                    .get(..count)
                    .ok_or_else(|| io::Error::other("invalid Guest frame read count"))?,
            );
        }
    }
}
