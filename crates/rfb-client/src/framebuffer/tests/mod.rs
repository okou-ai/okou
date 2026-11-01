use std::{
    future::Future,
    task::{Context, Waker},
    time::Duration,
};

use flate2::{Compress, Compression, FlushCompress};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, duplex},
    time::{Instant, timeout_at},
};

use super::{Budget, Decompress, Error, PIXEL_FORMAT, inflate};
use crate::{SharingMode, VncPassword, authenticate_apple_vnc_password};

#[tokio::test]
async fn rejects_zrle_bombs_at_the_rectangle_memory_bound_and_releases_storage() {
    let decoded = vec![0; 1024 * 1024];
    let mut compressor = Compress::new(Compression::default(), true);
    let mut compressed = Vec::with_capacity(16 * 1024);
    compressor
        .compress_vec(&decoded, &mut compressed, FlushCompress::Sync)
        .unwrap();
    assert_eq!(compressor.total_in(), decoded.len() as u64);
    assert!(compressed.len() < 16 * 1024);

    for (width, height) in [(1_u16, 1_u16), (128, 128)] {
        let (stream, mut peer) = duplex(16 * 1024);
        let end = Instant::now() + Duration::from_secs(10);
        let caller = async {
            let authenticated = authenticate_apple_vnc_password(
                stream,
                VncPassword::new(" secret ".to_owned()).unwrap(),
                end,
            )
            .await
            .unwrap();
            let client = authenticated
                .initialize(SharingMode::Shared, end)
                .await
                .unwrap();
            // Keep the accounting observer after the owned update drops its
            // connection, without exposing a public testing interface.
            let budget = client.budget.clone();
            let baseline = client.memory_usage().0;
            assert!(baseline > 0);
            assert!(matches!(
                client.update(false, end).await,
                Err(Error::InvalidCompressedData)
            ));
            let (retained, peak) = budget.usage();
            assert_eq!(
                retained, 0,
                "failed update must release all decoder storage"
            );
            // The 1x1 rectangle allows 386 decoded bytes plus one overflow
            // detection byte, even when the framebuffer itself is larger.
            let bound = baseline + compressed.len() + 387;
            assert!(
                peak <= bound,
                "rectangle-bound inflate scratch exceeded: peak={peak}, bound={bound}, framebuffer={width}x{height}"
            );
        };
        let server = async {
            peer.write_all(b"RFB 003.889\n").await.unwrap();
            let mut version = [0; 12];
            peer.read_exact(&mut version).await.unwrap();
            assert_eq!(&version, b"RFB 003.008\n");
            peer.write_all(&[1, 2]).await.unwrap();
            assert_eq!(peer.read_u8().await.unwrap(), 2);
            peer.write_all(b"0123456789abcdef").await.unwrap();
            let mut response = [0; 16];
            peer.read_exact(&mut response).await.unwrap();
            peer.write_u32(0).await.unwrap();
            assert_eq!(peer.read_u8().await.unwrap(), 1);
            peer.write_u16(width).await.unwrap();
            peer.write_u16(height).await.unwrap();
            peer.write_all(&PIXEL_FORMAT[4..]).await.unwrap();
            peer.write_u32(0).await.unwrap(); // Empty desktop name.
            let mut settings = [0; 44]; // SetPixelFormat and SetEncodings.
            peer.read_exact(&mut settings).await.unwrap();
            let mut request = [0; 10];
            peer.read_exact(&mut request).await.unwrap();
            assert_eq!(&request[..6], &[3, 0, 0, 0, 0, 0]);
            assert_eq!(&request[6..8], &width.to_be_bytes());
            assert_eq!(&request[8..], &height.to_be_bytes());
            peer.write_all(&[0, 0, 0, 1]).await.unwrap(); // One rectangle.
            peer.write_all(&[0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 16])
                .await
                .unwrap(); // 1x1 ZRLE at the origin.
            peer.write_u32(u32::try_from(compressed.len()).unwrap())
                .await
                .unwrap();
            peer.write_all(&compressed).await.unwrap();
            let mut byte = [0];
            assert_eq!(peer.read(&mut byte).await.unwrap(), 0, "peer must close");
        };
        timeout_at(end, async { tokio::join!(caller, server) })
            .await
            .unwrap();
    }
}

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
