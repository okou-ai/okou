//! Bounded complete messages carried inside the existing binary Data stream.
//!
//! A message starts with a u32 length and occupies one or more Data frames.
//! End/control may occur only between complete messages. Partial reads poison
//! the underlying reader: retain the future or drop the whole connection.

use std::io;
use tokio::io::{AsyncRead, AsyncWrite};

use super::{Frame, MAX_DATA_BYTES, Reader, Writer};

pub enum Message {
    Data(Vec<u8>),
    End,
    Control(crate::Response),
}

pub async fn read<R: AsyncRead + Unpin>(
    reader: &mut Reader<R>,
    maximum: usize,
) -> io::Result<Option<Message>> {
    let Some(first) = reader.next().await? else {
        return Ok(None);
    };
    let first = match first {
        Frame::End => return Ok(Some(Message::End)),
        Frame::Control(response) => return Ok(Some(Message::Control(response))),
        Frame::Data(bytes) => bytes,
    };
    let header: [u8; 4] = first
        .get(..4)
        .ok_or_else(invalid)?
        .try_into()
        .map_err(|_| invalid())?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > maximum || first.len() - 4 > size {
        return Err(invalid());
    }
    let mut message = Vec::with_capacity(size);
    message.extend_from_slice(first.get(4..).ok_or_else(invalid)?);
    while message.len() < size {
        let Some(Frame::Data(bytes)) = reader.next().await? else {
            return Err(invalid());
        };
        if bytes.len() > size - message.len() {
            return Err(invalid());
        }
        message.extend_from_slice(&bytes);
    }
    Ok(Some(Message::Data(message)))
}

pub async fn write<W: AsyncWrite + Unpin>(
    writer: &mut Writer<W>,
    message: &[u8],
    maximum: usize,
) -> io::Result<()> {
    if message.is_empty() || message.len() > maximum {
        return Err(invalid());
    }
    let size = u32::try_from(message.len()).map_err(|_| invalid())?;
    let first_size = message.len().min(MAX_DATA_BYTES - 4);
    let mut first = Vec::with_capacity(first_size + 4);
    first.extend_from_slice(&size.to_be_bytes());
    first.extend_from_slice(message.get(..first_size).ok_or_else(invalid)?);
    writer.send(&Frame::Data(first)).await?;
    for chunk in message
        .get(first_size..)
        .ok_or_else(invalid)?
        .chunks(MAX_DATA_BYTES)
    {
        writer.send(&Frame::Data(chunk.to_vec())).await?;
    }
    Ok(())
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid RPC message framing")
}
