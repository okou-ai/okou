use std::{future::Future, time::Duration};

use flate2::{Decompress, FlushDecompress, Status};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt},
    time::Instant,
};
use tokio_rustls::client::TlsStream;

use crate::{
    Authenticated, Error,
    memory::{Budget, Buffer, Reservation},
    pixels::{Frame, Rect},
    wire::{Wire, validate_format},
    zrle,
};

const MAX_COMPRESSED: usize = 40 * 1024 * 1024;
const INFLATE_CHUNK: usize = 64 * 1024;
// Conservatively reserve inflater state, fixed decoder tile/palette scratch and
// protocol buffers in addition to all capacity-accounted heap buffers.
const DECODER_OVERHEAD: usize = 256 * 1024;
const PIXEL_FORMAT: [u8; 20] = [
    0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0,
];

/// Cursor shape in canonical RGBA, separate from desktop pixels. RFB Cursor
/// supplies a hotspot, not its current desktop position; composition belongs to
/// the session layer. Empty cursor updates remove the shape.
pub struct Cursor {
    /// Shape width in pixels.
    pub width: u16,
    /// Shape height in pixels.
    pub height: u16,
    /// Horizontal hotspot within the shape.
    pub hotspot_x: u16,
    /// Vertical hotspot within the shape.
    pub hotspot_y: u16,
    pixels: Buffer,
}

impl Cursor {
    /// RGBA pixels with alpha taken from the per-row RFB cursor mask.
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }
}

/// An owned, authenticated framebuffer decoder. It never spawns a task or
/// reconnects. Updates consume ownership so failure or cancellation cannot leave
/// a partially decoded connection available to a caller.
pub struct FramebufferConnection<S> {
    stream: TlsStream<S>,
    frame: Frame,
    cursor: Option<Cursor>,
    inflater: Decompress,
    budget: Budget,
    _decoder_memory: Reservation,
    sequence: u64,
    needs_full: bool,
}

impl<S> FramebufferConnection<S> {
    /// Current framebuffer width.
    pub fn width(&self) -> u16 {
        self.frame.width
    }
    /// Current framebuffer height.
    pub fn height(&self) -> u16 {
        self.frame.height
    }
    /// Geometry identity; advances on every DesktopSize update, even same-size.
    pub fn geometry_epoch(&self) -> u64 {
        self.frame.epoch
    }
    /// Number of completely processed FramebufferUpdate messages.
    pub fn update_sequence(&self) -> u64 {
        self.sequence
    }
    /// Whether the next request must be nonincremental (initially and on resize).
    pub fn needs_full_update(&self) -> bool {
        self.needs_full
    }
    /// Complete desktop RGBA pixels, without cursor composition. None means some
    /// pixels have not been received since initialization, resize or full refresh.
    pub fn pixels(&self) -> Option<&[u8]> {
        self.frame.pixels()
    }
    /// Latest cursor shape, without a desktop position.
    pub fn cursor(&self) -> Option<&Cursor> {
        self.cursor.as_ref()
    }
    /// Current and peak accounted bytes: buffer capacities plus a conservative
    /// inflater/fixed-scratch reservation. TLS/socket and caller copies are excluded.
    pub fn memory_usage(&self) -> (usize, usize) {
        self.budget.usage()
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> Authenticated<S> {
    /// Initialize shared-mode RFB and negotiate the supported true-color encoding
    /// profile. No framebuffer request is sent until update(). The earlier of the
    /// caller deadline and 30 seconds bounds initialization. Error/cancellation
    /// drops the owned stream; no unauthenticated constructor exists.
    pub async fn initialize(self, deadline: Instant) -> Result<FramebufferConnection<S>, Error> {
        bounded(deadline, initialize(self.into_stream())).await
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> FramebufferConnection<S> {
    /// Send one full-frame update request and process one FramebufferUpdate.
    /// A nonincremental request clears coverage before receiving any pixels;
    /// subsequent incremental requests can accumulate partial coverage. A resize
    /// requires a new nonincremental request. Bell and bounded standard clipboard
    /// messages are discarded. No input, clipboard reply or retry is sent.
    ///
    /// The earlier of deadline and 30 seconds bounds the entire operation. A
    /// successful result is rechecked against that deadline. Dropping this future
    /// drops the connection and all buffers, including in-progress decoder scratch.
    pub async fn update(self, incremental: bool, deadline: Instant) -> Result<Self, Error> {
        bounded(deadline, self.update_inner(incremental)).await
    }

    async fn update_inner(mut self, incremental: bool) -> Result<Self, Error> {
        if incremental && self.needs_full {
            return Err(Error::FullUpdateRequired);
        }
        if !incremental {
            self.frame.invalidate();
            self.needs_full = false;
        }
        let mut request = [3, u8::from(incremental), 0, 0, 0, 0, 0, 0, 0, 0];
        request
            .get_mut(6..8)
            .ok_or(Error::InvalidFramebuffer)?
            .copy_from_slice(&self.frame.width.to_be_bytes());
        request
            .get_mut(8..10)
            .ok_or(Error::InvalidFramebuffer)?
            .copy_from_slice(&self.frame.height.to_be_bytes());
        self.stream.write_all(&request).await?;
        self.stream.flush().await?;
        let mut wire = Wire::new();
        // Bound chatter as well as bytes: Bells have no payload.
        for _ in 0..64 {
            match wire.byte(&mut self.stream).await? {
                0 => {
                    wire.byte(&mut self.stream).await?;
                    let count = wire.short(&mut self.stream).await?;
                    if count > 4096 {
                        return Err(Error::ResourceLimit);
                    }
                    for _ in 0..count {
                        self.rectangle(&mut wire).await?;
                        tokio::task::yield_now().await;
                    }
                    self.sequence = self.sequence.checked_add(1).ok_or(Error::ResourceLimit)?;
                    return Ok(self);
                }
                2 => {}
                3 => {
                    let mut padding = [0; 3];
                    wire.bytes(&mut self.stream, &mut padding).await?;
                    let len = wire.long(&mut self.stream).await?;
                    if len > 4096 {
                        return Err(Error::ResourceLimit);
                    }
                    let _discarded = wire
                        .buffer(&mut self.stream, len as usize, &self.budget)
                        .await?;
                }
                _ => return Err(Error::UnsupportedMessage),
            }
        }
        Err(Error::ResourceLimit)
    }

    async fn rectangle(&mut self, wire: &mut Wire) -> Result<(), Error> {
        let rect = Rect {
            x: wire.short(&mut self.stream).await?,
            y: wire.short(&mut self.stream).await?,
            width: wire.short(&mut self.stream).await?,
            height: wire.short(&mut self.stream).await?,
        };
        let encoding = wire.long(&mut self.stream).await? as i32;
        match encoding {
            -223 => {
                let epoch = self
                    .frame
                    .epoch
                    .checked_add(1)
                    .ok_or(Error::ResourceLimit)?;
                self.frame = Frame::new(rect.width, rect.height, epoch, &self.budget)?;
                self.needs_full = true;
            }
            -239 => self.read_cursor(rect, wire).await?,
            0 | 1 | 16 => {
                self.frame.validate(rect)?;
                match encoding {
                    1 => {
                        let x = wire.short(&mut self.stream).await?;
                        let y = wire.short(&mut self.stream).await?;
                        self.frame.copy(rect, x, y).await?;
                    }
                    0 => {
                        let len = usize::from(rect.width) * usize::from(rect.height) * 4;
                        let mut rgba = wire.buffer(&mut self.stream, len, &self.budget).await?;
                        for pixel in rgba.as_chunks_mut::<4>().0 {
                            *pixel.get_mut(3).ok_or(Error::InvalidFramebuffer)? = 255;
                        }
                        self.frame.paint(rect, &rgba).await?;
                    }
                    _ => self.read_zrle(rect, wire).await?,
                }
            }
            _ => return Err(Error::UnsupportedEncoding),
        }
        Ok(())
    }

    async fn read_cursor(&mut self, rect: Rect, wire: &mut Wire) -> Result<(), Error> {
        if rect.width > 256 || rect.height > 256 {
            return Err(Error::ResourceLimit);
        }
        if rect.width == 0 || rect.height == 0 {
            self.cursor = None;
            return Ok(());
        }
        if rect.x >= rect.width || rect.y >= rect.height {
            return Err(Error::InvalidFramebuffer);
        }
        let len = usize::from(rect.width) * usize::from(rect.height) * 4;
        let mut pixels = wire.buffer(&mut self.stream, len, &self.budget).await?;
        let stride = usize::from(rect.width).div_ceil(8);
        let mask = wire
            .buffer(
                &mut self.stream,
                stride * usize::from(rect.height),
                &self.budget,
            )
            .await?;
        for (i, pixel) in pixels.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let row = i / usize::from(rect.width);
            let col = i % usize::from(rect.width);
            let bit = mask
                .get(row * stride + col / 8)
                .ok_or(Error::InvalidFramebuffer)?
                & (0x80 >> (col % 8));
            *pixel.get_mut(3).ok_or(Error::InvalidFramebuffer)? = if bit == 0 { 0 } else { 255 };
        }
        self.cursor = Some(Cursor {
            width: rect.width,
            height: rect.height,
            hotspot_x: rect.x,
            hotspot_y: rect.y,
            pixels,
        });
        Ok(())
    }

    async fn read_zrle(&mut self, rect: Rect, wire: &mut Wire) -> Result<(), Error> {
        let compressed_len = wire.long(&mut self.stream).await? as usize;
        if compressed_len == 0 || compressed_len > MAX_COMPRESSED {
            return Err(Error::ResourceLimit);
        }
        let compressed = wire
            .buffer(&mut self.stream, compressed_len, &self.budget)
            .await?;
        let width = usize::from(rect.width);
        let height = usize::from(rect.height);
        let count = width * height;
        // Worst-case plain RLE: four bytes/pixel. Allow a complete 127-color
        // palette plus header per tile, including narrow edge tiles.
        let limit = count * 4 + width.div_ceil(64) * height.div_ceil(64) * 382;
        let (decoded, len) = inflate(&mut self.inflater, &compressed, limit, &self.budget).await?;
        // Retain only the decoded chunk before allocating its RGBA counterpart.
        // This permits high-entropy 4K rectangles within the same total budget.
        drop(compressed);
        let mut rgba = self.budget.buffer(count * 4)?;
        // Keep tile storage out of nested async future layouts. A stack array
        // here propagates through update/timeout callers and can overflow an
        // ordinary thread stack even for a one-pixel update.
        let mut tile = self.budget.buffer(64 * 64 * 4)?;
        zrle::decode(
            decoded.get(..len).ok_or(Error::InvalidCompressedData)?,
            width,
            height,
            &mut rgba,
            &mut tile,
        )
        .await?;
        self.frame.paint(rect, &rgba).await?;
        Ok(())
    }
}

async fn initialize<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: TlsStream<S>,
) -> Result<FramebufferConnection<S>, Error> {
    stream.write_u8(1).await?;
    stream.flush().await?;
    let mut wire = Wire::new();
    let width = wire.short(&mut stream).await?;
    let height = wire.short(&mut stream).await?;
    crate::pixels::pixel_count(width, height)?;
    let mut format = [0; 16];
    wire.bytes(&mut stream, &mut format).await?;
    validate_format(format)?;
    let name_len = wire.long(&mut stream).await? as usize;
    if name_len > 4096 {
        return Err(Error::ResourceLimit);
    }
    let mut name = [0; 4096];
    wire.bytes(
        &mut stream,
        name.get_mut(..name_len).ok_or(Error::ResourceLimit)?,
    )
    .await?;
    let budget = Budget::default();
    let decoder_memory = budget.reserve(DECODER_OVERHEAD)?;
    let frame = Frame::new(width, height, 0, &budget)?;
    stream.write_all(&PIXEL_FORMAT).await?;
    stream.write_all(&[2, 0, 0, 5]).await?;
    for encoding in [16_i32, 1, 0, -239, -223] {
        stream.write_i32(encoding).await?;
    }
    stream.flush().await?;
    Ok(FramebufferConnection {
        stream,
        frame,
        cursor: None,
        inflater: Decompress::new(true),
        budget,
        _decoder_memory: decoder_memory,
        sequence: 0,
        needs_full: true,
    })
}

async fn bounded<T>(
    deadline: Instant,
    future: impl Future<Output = Result<T, Error>>,
) -> Result<T, Error> {
    let deadline = deadline.min(Instant::now() + Duration::from_secs(30));
    if deadline <= Instant::now() {
        return Err(Error::DeadlineExceeded);
    }
    let value = tokio::time::timeout_at(deadline, future)
        .await
        .map_err(|_| Error::DeadlineExceeded)??;
    if deadline <= Instant::now() {
        return Err(Error::DeadlineExceeded);
    }
    Ok(value)
}

async fn inflate(
    inflater: &mut Decompress,
    compressed: &[u8],
    limit: usize,
    budget: &Budget,
) -> Result<(Buffer, usize), Error> {
    let mut output = budget.buffer(limit + 1)?;
    let mut input_pos = 0;
    let mut output_pos = 0;
    loop {
        let before_in = inflater.total_in();
        let before_out = inflater.total_out();
        // Empty DEFLATE blocks consume input without filling output. Bound both
        // sides so one synchronous call cannot process the entire wire payload.
        let input_end = (input_pos + INFLATE_CHUNK).min(compressed.len());
        let output_end = (output_pos + INFLATE_CHUNK).min(output.len());
        let status = inflater
            .decompress(
                compressed
                    .get(input_pos..input_end)
                    .ok_or(Error::InvalidCompressedData)?,
                output
                    .get_mut(output_pos..output_end)
                    .ok_or(Error::InvalidCompressedData)?,
                FlushDecompress::Sync,
            )
            .map_err(|_| Error::InvalidCompressedData)?;
        let read = usize::try_from(inflater.total_in() - before_in)
            .map_err(|_| Error::InvalidCompressedData)?;
        let written = usize::try_from(inflater.total_out() - before_out)
            .map_err(|_| Error::InvalidCompressedData)?;
        input_pos += read;
        output_pos += written;
        if output_pos > limit || status == Status::StreamEnd {
            return Err(Error::InvalidCompressedData);
        }
        if read == 0 && written == 0 {
            if input_pos != compressed.len() {
                return Err(Error::InvalidCompressedData);
            }
            return Ok((output, output_pos));
        }
        tokio::task::yield_now().await;
    }
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        task::{Context, Waker},
    };

    use super::{Budget, Decompress, inflate};

    #[tokio::test]
    async fn cancelling_inflate_leaves_cpu_input_unconsumed_and_releases_scratch() {
        let mut compressed = vec![0x78, 0x01];
        for _ in 0..200_000 {
            compressed.extend([0, 0, 0, 0xff, 0xff]); // Empty stored blocks.
        }
        compressed.extend([0, 4, 0, 0xfb, 0xff, 1, 255, 0, 0]); // Solid red tile.
        compressed.extend([0, 0, 0, 0xff, 0xff]);
        let mut inflater = Decompress::new(true);
        let budget = Budget::default();
        // Poll the CPU-only future directly: a TCP readiness wait must not be
        // mistaken for the decoder yielding while work remains to cancel.
        let mut pending = Box::pin(inflate(&mut inflater, &compressed, 386, &budget));
        let mut context = Context::from_waker(Waker::noop());
        assert!(pending.as_mut().poll(&mut context).is_pending());
        drop(pending);
        assert!(inflater.total_in() > 0);
        assert!(
            inflater.total_in() < compressed.len() as u64,
            "cancellation must interrupt input-heavy decoding before all CPU work finishes"
        );
        assert_eq!(budget.usage().0, 0, "cancelled scratch must be released");
    }
}
