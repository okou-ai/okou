use crate::error::ProtocolError;
use crate::read::{read_u8_at, read_u32_at};
use crate::wire::{HEADER_SIZE, MAX_MESSAGE_SIZE, MIN_BODY_SIZE};
use std::convert::Infallible;

const INITIAL_BUFFER_CAPACITY: usize = 64 * 1024;
const OVERSIZED_BUFFER_CAPACITY: usize = 4 * 1024 * 1024;

/// A raw decoded message.
#[derive(Debug, Clone)]
pub struct RawMessage {
    /// Wire message type byte.
    pub msg_type: u8,
    /// Wire sequence number from the frame header.
    ///
    /// See the crate-level wire-format documentation for request-scoped and
    /// unsolicited-frame sequence rules.
    pub seq: u32,
    /// Owned type-specific payload bytes.
    pub payload: Vec<u8>,
}

impl RawMessage {
    /// Borrow this owned message without copying its payload.
    pub fn as_borrowed(&self) -> BorrowedRawMessage<'_> {
        BorrowedRawMessage {
            msg_type: self.msg_type,
            seq: self.seq,
            payload: &self.payload,
        }
    }
}

/// A raw decoded message that borrows its payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BorrowedRawMessage<'a> {
    /// Wire message type byte.
    pub msg_type: u8,
    /// Wire sequence number from the frame header.
    ///
    /// See the crate-level wire-format documentation for request-scoped and
    /// unsolicited-frame sequence rules.
    pub seq: u32,
    /// Borrowed type-specific payload bytes.
    pub payload: &'a [u8],
}

impl BorrowedRawMessage<'_> {
    /// Convert this borrowed message into an owned message by copying its payload.
    pub fn to_owned_message(self) -> RawMessage {
        RawMessage {
            msg_type: self.msg_type,
            seq: self.seq,
            payload: self.payload.to_vec(),
        }
    }
}

/// Error returned by [`Decoder::decode_with`].
#[derive(Debug, Clone)]
pub enum DecodeWithError<E> {
    /// The byte stream contains an invalid frame.
    Protocol(ProtocolError),
    /// The visitor rejected a complete decoded frame.
    Visitor(E),
}

/// Encode a raw message: `[4-byte length][1-byte type][4-byte seq][payload]`.
pub fn encode(msg_type: u8, seq: u32, payload: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    let mut buf = Vec::new();
    encode_into(&mut buf, msg_type, seq, payload.len(), |frame| {
        frame.extend_from_slice(payload);
    })?;
    Ok(buf)
}

pub(crate) fn encode_into(
    frame: &mut Vec<u8>,
    msg_type: u8,
    seq: u32,
    payload_len: usize,
    append_payload: impl FnOnce(&mut Vec<u8>),
) -> Result<(), ProtocolError> {
    frame.clear();
    let body_len = MIN_BODY_SIZE
        .checked_add(payload_len)
        .ok_or(ProtocolError::MessageTooLarge(usize::MAX))?;
    if body_len > MAX_MESSAGE_SIZE {
        return Err(ProtocolError::MessageTooLarge(body_len));
    }

    frame.reserve(HEADER_SIZE + body_len);
    frame.extend_from_slice(&(body_len as u32).to_be_bytes());
    frame.push(msg_type);
    frame.extend_from_slice(&seq.to_be_bytes());
    append_payload(frame);
    debug_assert_eq!(frame.len(), HEADER_SIZE + body_len);
    Ok(())
}

/// Buffered message decoder for streaming data.
pub struct Decoder {
    buf: Vec<u8>,
}

impl Decoder {
    /// Create an empty streaming decoder.
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(INITIAL_BUFFER_CAPACITY),
        }
    }

    /// Feed data and extract complete messages.
    pub fn decode(&mut self, data: &[u8]) -> Result<Vec<RawMessage>, ProtocolError> {
        let mut messages = Vec::new();
        let result = self.decode_with(data, |msg| {
            messages.push(msg.to_owned_message());
            Ok::<(), Infallible>(())
        });

        match result {
            Ok(()) => Ok(messages),
            Err(DecodeWithError::Protocol(error)) => Err(error),
            Err(DecodeWithError::Visitor(error)) => match error {},
        }
    }

    /// Feed data and visit complete messages while they still borrow the decoder buffer.
    ///
    /// Protocol errors are detected before any complete frame in the current
    /// buffered data is visited, preserving the all-or-error behavior of [`Self::decode`].
    /// When a protocol error is returned, all currently buffered data is
    /// discarded, including complete frames that were preflighted before the
    /// invalid frame. The decoder is left empty and can be reused with
    /// subsequent input.
    /// If the visitor returns an error, frames through the rejected frame are
    /// consumed and later complete frames remain buffered.
    pub fn decode_with<E>(
        &mut self,
        data: &[u8],
        mut visitor: impl FnMut(BorrowedRawMessage<'_>) -> Result<(), E>,
    ) -> Result<(), DecodeWithError<E>> {
        self.buf.extend_from_slice(data);
        let mut verified_offset = 0;

        while verified_offset + HEADER_SIZE <= self.buf.len() {
            let length = match read_u32_at(&self.buf, verified_offset) {
                Some(v) => v as usize,
                None => break,
            };

            if length > MAX_MESSAGE_SIZE {
                self.clear_after_protocol_error();
                return Err(DecodeWithError::Protocol(ProtocolError::MessageTooLarge(
                    length,
                )));
            }
            if length < MIN_BODY_SIZE {
                self.clear_after_protocol_error();
                return Err(DecodeWithError::Protocol(ProtocolError::MessageTooSmall(
                    length,
                )));
            }

            let total = HEADER_SIZE + length;
            if verified_offset + total > self.buf.len() {
                break;
            }

            verified_offset += total;
        }

        let mut offset = 0;
        while offset < verified_offset {
            let length = match read_u32_at(&self.buf, offset) {
                Some(v) => v as usize,
                None => break,
            };
            let total = HEADER_SIZE + length;
            let next_offset = offset + total;
            let msg_type = match read_u8_at(&self.buf, offset + HEADER_SIZE) {
                Some(v) => v,
                None => break,
            };
            let seq = match read_u32_at(&self.buf, offset + HEADER_SIZE + 1) {
                Some(v) => v,
                None => break,
            };
            let payload_start = offset + HEADER_SIZE + MIN_BODY_SIZE;
            let payload = self.buf.get(payload_start..next_offset).unwrap_or_default();
            let result = visitor(BorrowedRawMessage {
                msg_type,
                seq,
                payload,
            });
            if let Err(error) = result {
                self.buf.drain(..next_offset);
                self.release_oversized_buffer();
                return Err(DecodeWithError::Visitor(error));
            }
            offset = next_offset;
        }

        // Compact: remove consumed bytes once at the end
        if verified_offset > 0 {
            self.buf.drain(..verified_offset);
        }
        self.release_oversized_buffer();

        Ok(())
    }

    fn clear_after_protocol_error(&mut self) {
        self.buf.clear();
        self.release_oversized_buffer();
    }

    fn release_oversized_buffer(&mut self) {
        if self.buf.capacity() <= OVERSIZED_BUFFER_CAPACITY {
            return;
        }

        if self.buf.is_empty() {
            self.buf = Vec::with_capacity(INITIAL_BUFFER_CAPACITY);
        } else if self.buf.len() <= INITIAL_BUFFER_CAPACITY {
            let mut buf = Vec::with_capacity(INITIAL_BUFFER_CAPACITY);
            buf.extend_from_slice(&self.buf);
            self.buf = buf;
        }
    }
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests;
