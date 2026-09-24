use std::{io::Write, time::SystemTime};

use crate::{
    Cursor, Error, FramebufferConnection, Geometry,
    memory::{Budget, Buffer},
};

const MAX_PNG: usize = 16 * 1024 * 1024;
const INITIAL_PNG_CAPACITY: usize = 1024;
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
    overflow: bool,
    resource_limited: bool,
}

impl Write for BoundedOutput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let end = self.buffer.len().checked_add(bytes.len());
        let Some(end) = end.filter(|&end| end <= MAX_PNG) else {
            self.overflow = true;
            return Err(std::io::Error::other("PNG limit exceeded"));
        };
        if end > self.buffer.capacity() {
            let capacity = end
                .max(self.buffer.capacity().saturating_mul(2))
                .clamp(INITIAL_PNG_CAPACITY, MAX_PNG);
            if self.buffer.try_reserve_capacity(capacity).is_err() {
                self.resource_limited = true;
                return Err(std::io::Error::other("PNG output memory limit exceeded"));
            }
        }
        self.buffer.append(bytes);
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
        buffer: budget.buffer(0)?,
        overflow: false,
        resource_limited: false,
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
        } else if output.resource_limited {
            Error::ResourceLimit
        } else {
            Error::ImageEncoding
        });
    }
    drop(overhead);
    Ok(output.buffer)
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        task::{Context, Waker},
    };

    use super::{Budget, ENCODER_OVERHEAD, Error, MAX_PNG, encode_png};
    use crate::memory::MAX_MEMORY;

    #[tokio::test]
    async fn small_png_uses_and_retains_only_grown_capacity() {
        let budget = Budget::default();
        let pixels = vec![255; 64 * 64 * 4];
        let png = encode_png(&pixels, 64, 64, &budget).await.unwrap();
        assert!(png.len() < MAX_PNG);
        assert!(budget.usage().1 < 3 * 1024 * 1024);
        assert_eq!(budget.usage().0, png.capacity());
        drop(png);
        assert_eq!(budget.usage().0, 0);
    }

    #[tokio::test]
    async fn small_png_succeeds_with_less_than_max_output_headroom() {
        let budget = Budget::default();
        let occupied = budget
            .reserve(MAX_MEMORY - ENCODER_OVERHEAD - 64 * 1024)
            .unwrap();
        let pixels = vec![255; 64 * 64 * 4];
        let png = encode_png(&pixels, 64, 64, &budget).await.unwrap();
        assert!(png.len() < 64 * 1024);
        drop(png);
        assert_eq!(budget.usage().0, MAX_MEMORY - ENCODER_OVERHEAD - 64 * 1024);
        drop(occupied);
        assert_eq!(budget.usage().0, 0);
    }

    #[tokio::test]
    async fn png_growth_failure_releases_temporary_reservations() {
        let budget = Budget::default();
        let occupied = budget.reserve(MAX_MEMORY - ENCODER_OVERHEAD - 512).unwrap();
        let pixels = vec![255; 64 * 64 * 4];
        assert!(matches!(
            encode_png(&pixels, 64, 64, &budget).await,
            Err(Error::ResourceLimit)
        ));
        assert_eq!(budget.usage().0, MAX_MEMORY - ENCODER_OVERHEAD - 512);
        drop(occupied);
        assert_eq!(budget.usage().0, 0);
    }

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
        assert!(budget.usage().1 < 3 * 1024 * 1024);
        drop(pending);
        assert_eq!(budget.usage().0, 0);
    }
}
