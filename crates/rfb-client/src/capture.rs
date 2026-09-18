use std::{io::Write, time::SystemTime};

use crate::{
    Cursor, Error, FramebufferConnection, Geometry,
    memory::{Budget, Buffer},
};

const MAX_PNG: usize = 16 * 1024 * 1024;
// png's streaming writer retains three <=32KiB rows, an 8KiB IDAT
// buffer and bounded flate2 compressor state. Reserve conservatively before construction.
const ENCODER_OVERHEAD: usize = 2 * 1024 * 1024;

/// Identity of the complete frame used to encode one capture.
#[derive(Clone, Copy, Debug)]
pub struct CaptureMetadata {
    pub geometry: Geometry,
    pub width: u16,
    pub height: u16,
    pub update_sequence: u64,
    pub captured_at: SystemTime,
}

/// Immutable PNG and cursor snapshot, retaining their session memory charges.
/// The PNG excludes the cursor; its position is unavailable in this RFB profile.
pub struct Capture {
    png: Buffer,
    metadata: CaptureMetadata,
    cursor: Option<Cursor>,
}

impl Capture {
    pub fn png(&self) -> &[u8] {
        &self.png
    }

    pub fn metadata(&self) -> &CaptureMetadata {
        &self.metadata
    }

    pub fn cursor(&self) -> Option<&Cursor> {
        self.cursor.as_ref()
    }
}

struct BoundedOutput {
    buffer: Buffer,
    len: usize,
    overflow: bool,
}

impl Write for BoundedOutput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let end = self.len.checked_add(bytes.len());
        let Some(end) = end.filter(|&end| end <= self.buffer.len()) else {
            self.overflow = true;
            return Err(std::io::Error::other("PNG limit exceeded"));
        };
        self.buffer
            .get_mut(self.len..end)
            .ok_or_else(|| std::io::Error::other("invalid PNG output range"))?
            .copy_from_slice(bytes);
        self.len = end;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(crate) async fn encode<S>(
    connection: &FramebufferConnection<S>,
    geometry: Geometry,
) -> Result<Capture, Error> {
    let pixels = connection.pixels().ok_or(Error::InvalidFramebuffer)?;
    let metadata = CaptureMetadata {
        geometry,
        width: connection.width(),
        height: connection.height(),
        update_sequence: connection.update_sequence(),
        captured_at: SystemTime::now(),
    };
    let png = encode_png(pixels, metadata.width, metadata.height, &connection.budget).await?;
    let cursor = connection
        .cursor()
        .map(|cursor| cursor.snapshot(&connection.budget))
        .transpose()?;
    Ok(Capture {
        png,
        metadata,
        cursor,
    })
}

async fn encode_png(
    pixels: &[u8],
    width: u16,
    height: u16,
    budget: &Budget,
) -> Result<Buffer, Error> {
    let overhead = budget.reserve(ENCODER_OVERHEAD)?;
    let mut output = BoundedOutput {
        buffer: budget.buffer(MAX_PNG)?,
        len: 0,
        overflow: false,
    };
    let result = async {
        let mut encoder = png::Encoder::new(&mut output, u32::from(width), u32::from(height));
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        // Use the fallible flate2 writer path: fdeflate's fast writer can panic
        // on sink errors, whereas reaching our output cap must be a normal error.
        encoder.set_deflate_compression(png::DeflateCompression::Level(1));
        encoder.set_filter(png::Filter::Up);
        let mut writer = encoder.write_header()?;
        {
            let mut stream = writer.stream_writer_with_size(8192)?;
            for row in pixels.chunks_exact(usize::from(width) * 4) {
                stream.write_all(row)?;
                tokio::task::yield_now().await;
            }
            stream.finish()?;
        }
        writer.finish()
    }
    .await;
    if result.is_err() {
        return Err(if output.overflow {
            Error::ImageTooLarge
        } else {
            Error::ImageEncoding
        });
    }
    // Keep only the actual PNG bytes. The transient old/new overlap is charged
    // too, so retaining small screenshots does not consume 16MiB each.
    drop(overhead);
    let mut png = budget.buffer(output.len)?;
    png.copy_from_slice(
        output
            .buffer
            .get(..output.len)
            .ok_or(Error::ImageEncoding)?,
    );
    drop(output);
    Ok(png)
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        task::{Context, Waker},
    };

    use super::{Budget, encode_png};

    #[tokio::test]
    async fn cancelling_cpu_encoding_releases_output_and_compressor_reservations() {
        let budget = Budget::default();
        let pixels = vec![255; 64 * 64 * 4];
        // A socket-readiness wait cannot establish that PNG CPU work yields.
        // Poll only encoding, stop at its first row yield, then cancel it.
        let mut pending = Box::pin(encode_png(&pixels, 64, 64, &budget));
        let mut context = Context::from_waker(Waker::noop());
        assert!(pending.as_mut().poll(&mut context).is_pending());
        assert!(budget.usage().0 > 0);
        drop(pending);
        assert_eq!(budget.usage().0, 0);
    }
}
