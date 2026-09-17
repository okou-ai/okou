#![cfg(test)]

pub mod common_framebuffer;

use std::{io, io::Cursor, time::Duration};

use common_framebuffer::*;
use rfb_client::{Capture, Error, Session};
use tokio::{
    io::AsyncWriteExt,
    net::TcpStream,
    time::{Instant, timeout},
};

const MEMORY_LIMIT: usize = 128 * 1024 * 1024;

fn noisy_pixels(width: u16, height: u16) -> Vec<u8> {
    let count = usize::from(width) * usize::from(height);
    let mut pixels = Vec::with_capacity(count * 4);
    for index in 0..count {
        // Deterministic avalanche mixing supplies independent RGB bytes without
        // random seeds. The fourth wire byte is padding, not another color.
        let mut value = (index as u32).wrapping_add(0x9e37_79b9);
        value = (value ^ (value >> 16)).wrapping_mul(0x85eb_ca6b);
        value = (value ^ (value >> 13)).wrapping_mul(0xc2b2_ae35);
        value ^= value >> 16;
        pixels.extend([value as u8, (value >> 8) as u8, (value >> 16) as u8, 0]);
    }
    pixels
}

async fn capture_raw(
    session: &mut Session<TcpStream>,
    peer: &mut Peer,
    width: u16,
    height: u16,
    rows: &[u8],
) -> Result<Capture, Error> {
    let row_bytes = usize::from(width) * 4;
    assert!(!rows.is_empty() && rows.len().is_multiple_of(row_bytes));
    let server = async {
        read_request(peer, false, width, height).await;
        peer.write_all(&[0, 0, 0, 1]).await?;
        peer.write_all(&rectangle(0, 0, width, height, 0, &[]))
            .await?;
        // A single supplied row repeats, avoiding a full-size solid fixture;
        // noise supplies all rows. Neither path copies a full wire message.
        for row in rows
            .chunks_exact(row_bytes)
            .cycle()
            .take(usize::from(height))
        {
            peer.write_all(row).await?;
        }
        peer.flush().await?;
        Ok::<(), io::Error>(())
    };
    let caller = session.capture(Instant::now() + Duration::from_secs(30));
    let (result, sent) = timeout(Duration::from_secs(35), async {
        tokio::join!(caller, server)
    })
    .await
    .expect("bounded full-frame capture and peer cleanup");
    if result.is_ok() {
        sent.unwrap();
    } else if let Err(error) = sent {
        // Budget rejection can close the connection before the complete Raw
        // payload arrives. The client result below still has to be the expected
        // resource/image error, not a transport error disguising the test case.
        assert!(matches!(
            error.kind(),
            io::ErrorKind::BrokenPipe
                | io::ErrorKind::ConnectionReset
                | io::ErrorKind::ConnectionAborted
                | io::ErrorKind::UnexpectedEof
        ));
    }
    result
}

#[tokio::test]
async fn captures_the_maximum_frame_as_complete_png_within_the_shared_budget() {
    let (client, mut peer) = initialized(8192, 1024).await;
    let mut session = Session::new(client);
    let row = [17, 34, 51, 0].repeat(8192);
    let capture = capture_raw(&mut session, &mut peer, 8192, 1024, &row)
        .await
        .unwrap();
    assert_eq!(
        (capture.metadata().width, capture.metadata().height),
        (8192, 1024)
    );
    let mut reader = png::Decoder::new(Cursor::new(capture.png()))
        .read_info()
        .unwrap();
    let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
    let frame = reader.next_frame(&mut pixels).unwrap();
    assert_eq!((frame.width, frame.height), (8192, 1024));
    assert_eq!(frame.color_type, png::ColorType::Rgba);
    assert_eq!(frame.bit_depth, png::BitDepth::Eight);
    assert_eq!(frame.buffer_size(), 8_388_608 * 4);
    assert!(
        pixels
            .as_chunks::<4>()
            .0
            .iter()
            .all(|pixel| *pixel == [17, 34, 51, 255])
    );
    drop(reader);
    drop(pixels);
    let (retained, peak) = session.memory_usage();
    assert!(retained <= peak && peak <= MEMORY_LIMIT);
    eprintln!(
        "maximum-frame PNG: bytes={}, retained={retained}, peak={peak}",
        capture.png().len()
    );
    session.close();
    disconnected(&mut peer).await;
    assert!(session.memory_usage().0 >= capture.png().len());
    drop(capture);
    assert_eq!(session.memory_usage().0, 0);
}

#[tokio::test]
async fn incompressible_capture_exceeding_png_limit_returns_error_and_releases_session() {
    // Build the independent input before starting the operation deadline.
    let pixels = noisy_pixels(8192, 1024);
    let (client, mut peer) = initialized(8192, 1024).await;
    let mut session = Session::new(client);
    let result = capture_raw(&mut session, &mut peer, 8192, 1024, &pixels).await;
    assert!(matches!(error(result), Error::ImageTooLarge));
    assert!(session.is_closed());
    assert_eq!(session.memory_usage().0, 0);
    assert!(session.memory_usage().1 <= MEMORY_LIMIT);
    disconnected(&mut peer).await;
}

#[tokio::test]
async fn retained_captures_exhaust_the_shared_budget_and_release_it_when_dropped() {
    // Each capture fits the 16 MiB image bound individually. Retaining their
    // actual noisy PNG buffers, rather than synthetic reservations, eventually
    // prevents another real capture from fitting the shared 128 MiB budget.
    let pixels = noisy_pixels(2048, 2048);
    let (client, mut peer) = initialized(2048, 2048).await;
    let mut session = Session::new(client);
    let mut captures = Vec::new();
    let mut exhausted = false;
    for _ in 0..12 {
        match capture_raw(&mut session, &mut peer, 2048, 2048, &pixels).await {
            Ok(capture) => {
                assert!(capture.png().len() > 8 * 1024 * 1024);
                assert!(capture.png().len() <= 16 * 1024 * 1024);
                captures.push(capture);
            }
            Err(Error::ResourceLimit) => {
                exhausted = true;
                break;
            }
            Err(error) => panic!("unexpected retained-capture failure: {error}"),
        }
    }
    assert!(
        exhausted,
        "retained image buffers must consume the session budget"
    );
    assert!(captures.len() >= 2);
    assert!(session.is_closed());
    disconnected(&mut peer).await;
    let image_bytes: usize = captures.iter().map(|capture| capture.png().len()).sum();
    let (retained, peak) = session.memory_usage();
    assert!(retained >= image_bytes && peak <= MEMORY_LIMIT);
    eprintln!(
        "retained PNG limit: captures={}, image_bytes={image_bytes}, retained={retained}, peak={peak}",
        captures.len()
    );
    let removed = captures.pop().unwrap();
    let removed_bytes = removed.png().len();
    drop(removed);
    assert!(session.memory_usage().0 <= retained - removed_bytes);
    drop(captures);
    assert_eq!(session.memory_usage().0, 0);
}
