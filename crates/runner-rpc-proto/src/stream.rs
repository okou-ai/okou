//! Opt-in binary streaming after one ordinary [`crate::Request`] frame.
//!
//! Input ends with an explicit End frame, not socket EOF. Responses still need
//! a unique terminal plus EOF. Neither framing nor a helper mode grants access.

use std::{borrow::Cow, io};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::{
    Delivery, HEADER_BYTES, MAX_RESPONSE_BYTES, MAX_RESPONSE_STREAM_BYTES, Response, ResponseState,
    encode, invalid, parse,
};

pub const MAX_DATA_BYTES: usize = 64 * 1024;
pub const MAX_STREAM_BYTES: u64 = 1024 * 1024 * 1024;
/// Includes End; a data frame must leave room for it.
pub const MAX_STREAM_FRAMES: u32 = 65_536;
pub const MAX_DURATION_MS: u64 = 15 * 60 * 1000;

pub enum Frame {
    Data(Vec<u8>),
    End,
    Control(Response),
}

#[derive(Clone)]
struct State {
    responses: bool,
    data_bytes: u64,
    data_frames: u32,
    ended: bool,
    control: ResponseState,
}

impl State {
    fn new(responses: bool) -> Self {
        Self {
            responses,
            data_bytes: 0,
            data_frames: 0,
            ended: false,
            control: ResponseState::default(),
        }
    }

    fn binary(&self, size: usize, end: bool) -> io::Result<()> {
        if self.control.terminal
            || self.ended
            || self.data_frames >= MAX_STREAM_FRAMES - u32::from(!end)
            || size > MAX_DATA_BYTES
            || (!end && size == 0)
            || size as u64 > MAX_STREAM_BYTES - self.data_bytes
        {
            return Err(invalid("invalid RPC binary stream"));
        }
        Ok(())
    }

    fn observe(&mut self, frame: &Frame, size: usize) -> io::Result<()> {
        if self.control.terminal {
            return Err(invalid("RPC frame after terminal"));
        }
        match frame {
            Frame::Data(data) => {
                self.binary(data.len(), false)?;
                self.data_bytes += data.len() as u64;
                self.data_frames += 1;
            }
            Frame::End => {
                self.binary(0, true)?;
                self.ended = true;
                self.data_frames += 1;
            }
            Frame::Control(response) => {
                if !self.responses
                    || matches!(response, Response::Result { .. })
                        && self.data_frames > 0
                        && !self.ended
                    || matches!(
                        response,
                        Response::Error {
                            delivery: Delivery::NotDispatched,
                            ..
                        }
                    ) && self.data_frames > 0
                {
                    return Err(invalid("invalid RPC stream control order"));
                }
                self.control.observe(response, size + HEADER_BYTES)?;
            }
        }
        Ok(())
    }
}

/// Cancellation or failure poisons this reader. Drop it instead of resuming.
pub struct Reader<R> {
    reader: R,
    state: State,
    failed: bool,
}

impl<R: AsyncRead + Unpin> Reader<R> {
    /// Read Data/End following the already-read Request. Stops at End without
    /// draining trailing bytes, which must never become another operation.
    pub fn input(reader: R) -> Self {
        Self {
            reader,
            state: State::new(false),
            failed: false,
        }
    }

    /// Read mixed binary/control frames through terminal AND transport EOF.
    pub fn responses(reader: R) -> Self {
        Self {
            reader,
            state: State::new(true),
            failed: false,
        }
    }

    pub async fn next(&mut self) -> io::Result<Option<Frame>> {
        if self.failed {
            return Err(invalid("RPC stream reader failed"));
        }
        if !self.state.responses && self.state.ended {
            return Ok(None);
        }
        self.failed = true;
        let mut header = [0; HEADER_BYTES];
        let (first, rest) = header.split_at_mut(1);
        if self.reader.read(first).await? == 0 {
            if !self.state.control.terminal {
                return Err(invalid("RPC stream ended without completion"));
            }
            self.failed = false;
            return Ok(None);
        }
        self.reader.read_exact(rest).await?;
        let size = u32::from_be_bytes(header) as usize;
        if self.state.control.terminal || size == 0 || size > MAX_DATA_BYTES + 1 {
            return Err(invalid("invalid RPC stream frame length"));
        }
        let tag = self.reader.read_u8().await?;
        let frame = match tag {
            0 => {
                self.state.binary(size - 1, false)?;
                let mut data = vec![0; size - 1];
                self.reader.read_exact(&mut data).await?;
                Frame::Data(data)
            }
            1 => {
                if size != 1 {
                    return Err(invalid("invalid RPC stream End"));
                }
                self.state.binary(0, true)?;
                Frame::End
            }
            _ => {
                if !self.state.responses
                    || size > MAX_RESPONSE_BYTES
                    || size + HEADER_BYTES > MAX_RESPONSE_STREAM_BYTES - self.state.control.bytes
                {
                    return Err(invalid("invalid RPC stream control length"));
                }
                let mut bytes = vec![tag];
                bytes.resize(size, 0);
                let (_, rest) = bytes.split_at_mut(1);
                self.reader.read_exact(rest).await?;
                Frame::Control(parse(&bytes)?)
            }
        };
        self.state.observe(&frame, size)?;
        self.failed = false;
        Ok(Some(frame))
    }
}

/// Bounded writer retaining its stream/reservation after End or terminal. The
/// owner must keep lifecycle cancellation active until all handler work ends.
pub struct Writer<W> {
    writer: W,
    state: State,
    failed: bool,
}

impl<W: AsyncWrite + Unpin> Writer<W> {
    pub fn input(writer: W) -> Self {
        Self {
            writer,
            state: State::new(false),
            failed: false,
        }
    }

    pub fn responses(writer: W) -> Self {
        Self {
            writer,
            state: State::new(true),
            failed: false,
        }
    }

    /// An untouched writer may report a safe failure; partially written output
    /// and a completed terminal must never receive a replacement response.
    pub fn is_usable(&self) -> bool {
        !self.failed && !self.state.control.terminal
    }

    pub async fn send(&mut self, frame: &Frame) -> io::Result<()> {
        if !self.is_usable() {
            return Err(invalid("RPC stream writer unavailable"));
        }
        let (tag, payload): (Option<u8>, Cow<'_, [u8]>) = match frame {
            Frame::Data(data) => (Some(0), Cow::Borrowed(data)),
            Frame::End => (Some(1), Cow::Borrowed(&[])),
            Frame::Control(response) => (None, Cow::Owned(encode(response, MAX_RESPONSE_BYTES)?)),
        };
        let size = payload
            .len()
            .checked_add(usize::from(tag.is_some()))
            .ok_or_else(|| invalid("RPC frame too large"))?;
        let mut next = self.state.clone();
        next.observe(frame, size)?;
        let size = u32::try_from(size).map_err(|_| invalid("RPC frame too large"))?;
        self.failed = true;
        self.writer.write_all(&size.to_be_bytes()).await?;
        if let Some(tag) = tag {
            self.writer.write_u8(tag).await?;
        }
        self.writer.write_all(&payload).await?;
        self.writer.flush().await?;
        if next.control.terminal {
            self.writer.shutdown().await?;
        }
        self.state = next;
        self.failed = false;
        Ok(())
    }
}
