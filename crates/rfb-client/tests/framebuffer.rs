#![cfg(test)]

mod common_framebuffer;

use std::time::Duration;

use common_framebuffer::*;
use flate2::{Compress, Compression, FlushCompress};
use rfb_client::Error;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    time::Instant,
};

fn compress_with(stream: &mut Compress, data: &[u8]) -> Vec<u8> {
    let before = stream.total_in();
    let mut output = Vec::with_capacity(data.len() * 2 + 4096);
    stream
        .compress_vec(data, &mut output, FlushCompress::Sync)
        .unwrap();
    assert_eq!(stream.total_in() - before, data.len() as u64);
    output
}

fn compress(data: &[u8]) -> Vec<u8> {
    compress_with(&mut Compress::new(Compression::default(), true), data)
}

#[tokio::test]
async fn negotiates_shared_rgbx_and_withholds_pixels_until_coverage_is_complete() {
    let (client, mut peer) = initialized(3, 2).await;
    assert_eq!((client.width(), client.height()), (3, 2));
    assert!(client.needs_full_update());
    assert!(client.pixels().is_none());
    assert_eq!(client.update_sequence(), 0);
    let epoch = client.geometry_epoch();
    let client = apply(client, &mut peer, false, &[raw(0, 0, 3, 1, &[RED; 3])]).await;
    assert!(!client.needs_full_update());
    assert!(client.pixels().is_none());
    assert_eq!(client.update_sequence(), 1);
    // Repeating the same region must not double-count covered pixels.
    let client = apply(client, &mut peer, true, &[raw(0, 0, 3, 1, &[GREEN; 3])]).await;
    assert!(client.pixels().is_none());
    let client = apply(client, &mut peer, true, &[raw(0, 1, 3, 1, &[BLUE; 3])]).await;
    assert_eq!(
        client.pixels().unwrap(),
        pixels(&[GREEN, GREEN, GREEN, BLUE, BLUE, BLUE])
    );
    assert_eq!(client.geometry_epoch(), epoch);
    assert_eq!(client.update_sequence(), 3);
    drop(client);
    disconnected(&mut peer).await;
}

#[tokio::test]
async fn accepts_valid_native_formats_before_normalizing_wire_pixels() {
    let mut indexed = [0; 16];
    indexed[0] = 8;
    indexed[1] = 8;
    let rgb565 = [16, 16, 2, 3, 0, 31, 0, 63, 0, 31, 11, 5, 0, 0, 0, 0];
    let mut historical_depth = RGBX;
    historical_depth[1] = 32;
    for format in [indexed, rgb565, historical_depth] {
        let (client, mut peer) = initialized_with_format(1, 1, format).await;
        let client = apply(client, &mut peer, false, &[raw(0, 0, 1, 1, &[RED])]).await;
        assert_eq!(client.pixels().unwrap(), RED);
    }
}

#[tokio::test]
async fn normalizes_native_true_color_formats_with_unused_channels() {
    // A zero-width channel has max = 2^0 - 1. These formats pack the other
    // two channels into eight bits; the unused channel may sit at the boundary.
    let formats = [
        ([8, 8, 0, 1, 0, 7, 0, 31, 0, 0, 0, 3, 0, 0, 0, 0], 12),
        ([8, 8, 0, 1, 0, 0, 0, 31, 0, 7, 0, 0, 5, 0, 0, 0], 10),
        ([8, 8, 0, 1, 0, 31, 0, 0, 0, 7, 0, 0, 5, 0, 0, 0], 11),
    ];
    for (mut format, unused_shift) in formats {
        for shift in [0, 8] {
            format[unused_shift] = shift;
            let (client, mut peer) = initialized_with_format(1, 1, format).await;
            let client = apply(client, &mut peer, false, &[raw(0, 0, 1, 1, &[WHITE])]).await;
            assert_eq!(client.pixels().unwrap(), WHITE);
            drop(client);
            disconnected(&mut peer).await;
        }
        format[unused_shift] = 9;
        assert!(matches!(
            rejected_init(&server_init(1, 1, format, b"desktop")).await,
            Error::InvalidPixelFormat
        ));
    }
}

#[tokio::test]
async fn rejects_initialization_bounds_and_invalid_pixel_formats() {
    for (width, height) in [(0, 1), (1, 0), (8193, 1), (4096, 4096)] {
        let result = rejected_init(&server_init(width, height, RGBX, b"desktop")).await;
        assert!(matches!(
            result,
            Error::InvalidFramebuffer | Error::ResourceLimit
        ));
    }
    let mut too_long = server_init(1, 1, RGBX, b"");
    too_long[20..24].copy_from_slice(&4097_u32.to_be_bytes());
    assert!(matches!(
        rejected_init(&too_long).await,
        Error::ResourceLimit
    ));
    for (offset, value) in [(0, 24), (1, 33), (5, 254), (10, 32), (11, 0), (1, 16)] {
        let mut format = RGBX;
        format[offset] = value;
        assert!(matches!(
            rejected_init(&server_init(1, 1, format, b"desktop")).await,
            Error::InvalidPixelFormat
        ));
    }
}

#[tokio::test]
async fn accepts_the_exact_remote_name_limit_without_exposing_name_in_errors() {
    let (client, mut peer) = authenticated().await;
    let name = vec![b'x'; 4096];
    let init = server_init(1, 1, RGBX, &name);
    let (client, ()) = bounded(async {
        tokio::join!(
            client.initialize(deadline()),
            negotiate_framebuffer(&mut peer, &init)
        )
    })
    .await;
    let client = client.unwrap();
    let result = error(apply_bytes(client, &mut peer, false, &[99]).await);
    assert!(matches!(result, Error::UnsupportedMessage));
    assert!(!format!("{result:?}").contains("xxxx"));
    disconnected(&mut peer).await;
}

#[tokio::test]
async fn requires_full_refresh_initially_and_resets_coverage_on_explicit_full_requests() {
    let (client, mut peer) = initialized(2, 1).await;
    assert!(matches!(
        error(client.update(true, deadline()).await),
        Error::FullUpdateRequired
    ));
    disconnected(&mut peer).await;

    let (client, mut peer) = initialized(2, 1).await;
    let client = apply(client, &mut peer, false, &[raw(0, 0, 2, 1, &[RED, BLUE])]).await;
    assert!(client.pixels().is_some());
    let client = apply(client, &mut peer, false, &[raw(0, 0, 1, 1, &[GREEN])]).await;
    assert!(
        client.pixels().is_none(),
        "a new full request must not expose old uncovered pixels"
    );
    let client = apply(client, &mut peer, true, &[raw(1, 0, 1, 1, &[BLACK])]).await;
    assert_eq!(client.pixels().unwrap(), pixels(&[GREEN, BLACK]));
}

#[tokio::test]
async fn copies_overlapping_rows_and_columns_with_snapshot_semantics() {
    let (client, mut peer) = initialized(3, 3).await;
    let initial = [RED, GREEN, BLUE, WHITE, BLACK, RED, BLUE, GREEN, WHITE];
    let client = apply(client, &mut peer, false, &[raw(0, 0, 3, 3, &initial)]).await;
    let client = apply(client, &mut peer, true, &[copy_rect(1, 1, 2, 2, 0, 0)]).await;
    assert_eq!(
        client.pixels().unwrap(),
        pixels(&[RED, GREEN, BLUE, WHITE, RED, GREEN, BLUE, WHITE, BLACK])
    );
    let client = apply(client, &mut peer, true, &[copy_rect(0, 0, 2, 2, 1, 1)]).await;
    assert_eq!(
        client.pixels().unwrap(),
        pixels(&[RED, GREEN, BLUE, WHITE, BLACK, GREEN, BLUE, WHITE, BLACK])
    );
}

#[tokio::test]
async fn copy_rect_propagates_missing_coverage_and_can_clear_valid_destination_pixels() {
    let (client, mut peer) = initialized(3, 1).await;
    let client = apply(client, &mut peer, false, &[raw(0, 0, 1, 1, &[RED])]).await;
    let client = apply(client, &mut peer, true, &[copy_rect(1, 0, 1, 1, 0, 0)]).await;
    assert!(client.pixels().is_none());
    let client = apply(
        client,
        &mut peer,
        true,
        &[copy_rect(0, 0, 1, 1, 2, 0), raw(2, 0, 1, 1, &[BLUE])],
    )
    .await;
    assert!(
        client.pixels().is_none(),
        "copying an unknown source must clear destination validity"
    );
    let client = apply(client, &mut peer, true, &[raw(0, 0, 1, 1, &[GREEN])]).await;
    assert_eq!(client.pixels().unwrap(), pixels(&[GREEN, RED, BLUE]));
}

#[tokio::test]
async fn decodes_every_zrle_mode_and_palette_row_padding() {
    let cases = [
        (
            3,
            1,
            vec![0, 255, 0, 0, 0, 255, 0, 0, 0, 255],
            vec![RED, GREEN, BLUE],
        ),
        (2, 2, vec![1, 255, 0, 0], vec![RED; 4]),
        (
            3,
            2,
            vec![2, 0, 0, 0, 255, 255, 255, 0x40, 0xa0],
            vec![BLACK, WHITE, BLACK, WHITE, BLACK, WHITE],
        ),
        (
            3,
            1,
            vec![3, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0x18],
            vec![RED, GREEN, BLUE],
        ),
        (16, 16, vec![128, 255, 0, 0, 255, 0], vec![RED; 256]),
        (
            2,
            2,
            vec![130, 255, 0, 0, 0, 0, 255, 128, 1, 129, 1],
            vec![RED, RED, BLUE, BLUE],
        ),
        (2, 1, vec![130, 255, 0, 0, 0, 0, 255, 0, 1], vec![RED, BLUE]),
    ];
    for (width, height, tile, expected) in cases {
        let (client, mut peer) = initialized(width, height).await;
        let client = apply(
            client,
            &mut peer,
            false,
            &[zrle(0, 0, width, height, &compress(&tile))],
        )
        .await;
        assert_eq!(client.pixels().unwrap(), pixels(&expected));
    }
    // Five-color palettes use nibbles; each odd-width row has its own padding.
    let mut tile = vec![5];
    for color in [RED, GREEN, BLUE, WHITE, BLACK] {
        tile.extend(&color[..3]);
    }
    tile.extend([0x01, 0x2f, 0x43, 0x0f]);
    let (client, mut peer) = initialized(3, 2).await;
    let client = apply(
        client,
        &mut peer,
        false,
        &[zrle(0, 0, 3, 2, &compress(&tile))],
    )
    .await;
    assert_eq!(
        client.pixels().unwrap(),
        pixels(&[RED, GREEN, BLUE, BLACK, WHITE, RED])
    );
}

#[tokio::test]
async fn preserves_the_zlib_stream_across_rectangles_with_independent_fixtures() {
    // Python zlib.compressobj(), each tile followed by Z_SYNC_FLUSH. The second
    // chunk has no zlib header and cannot be decoded by a newly created inflater.
    const FIRST: &[u8] = &[0x78, 0x9c, 0x62, 0xfc, 0xcf, 0xc0, 0, 0, 0, 0, 0xff, 0xff];
    const SECOND: &[u8] = &[0x62, 0x64, 0xf8, 0xcf, 0, 0, 0, 0, 0xff, 0xff];
    let (client, mut peer) = initialized(2, 1).await;
    let client = apply(client, &mut peer, false, &[zrle(0, 0, 1, 1, FIRST)]).await;
    assert!(client.pixels().is_none());
    let client = apply(client, &mut peer, true, &[zrle(1, 0, 1, 1, SECOND)]).await;
    assert_eq!(client.pixels().unwrap(), pixels(&[RED, GREEN]));
}

#[tokio::test]
async fn decodes_edge_tiles_in_rectangle_order() {
    let (client, mut peer) = initialized(65, 65).await;
    let mut tiles = Vec::new();
    for color in [RED, GREEN, BLUE, WHITE] {
        tiles.push(1);
        tiles.extend(&color[..3]);
    }
    let client = apply(
        client,
        &mut peer,
        false,
        &[zrle(0, 0, 65, 65, &compress(&tiles))],
    )
    .await;
    let output = client.pixels().unwrap();
    for y in 0..65 {
        for x in 0..65 {
            let expected = match (x == 64, y == 64) {
                (false, false) => RED,
                (true, false) => GREEN,
                (false, true) => BLUE,
                (true, true) => WHITE,
            };
            assert_eq!(&output[(y * 65 + x) * 4..][..4], expected);
        }
    }
}

#[tokio::test]
async fn resizes_mid_update_ignores_pseudo_coordinates_and_requires_new_coverage() {
    let (client, mut peer) = initialized(1, 1).await;
    let client = apply(client, &mut peer, false, &[raw(0, 0, 1, 1, &[RED])]).await;
    let epoch = client.geometry_epoch();
    let client = apply(
        client,
        &mut peer,
        true,
        &[
            rectangle(65535, 65535, 2, 1, -223, &[]),
            raw(0, 0, 1, 1, &[GREEN]),
        ],
    )
    .await;
    assert_eq!((client.width(), client.height()), (2, 1));
    assert_eq!(client.geometry_epoch(), epoch + 1);
    assert!(client.needs_full_update());
    assert!(client.pixels().is_none());
    let client = apply(client, &mut peer, false, &[raw(1, 0, 1, 1, &[BLUE])]).await;
    assert!(
        client.pixels().is_none(),
        "full refresh must replace even post-resize partial coverage"
    );
    let client = apply(client, &mut peer, true, &[raw(0, 0, 1, 1, &[WHITE])]).await;
    assert_eq!(client.pixels().unwrap(), pixels(&[WHITE, BLUE]));
    assert_eq!(client.geometry_epoch(), epoch + 1);
}

#[tokio::test]
async fn decodes_cursor_hotspot_full_pixels_and_independently_padded_mask_rows() {
    let (client, mut peer) = initialized(1, 1).await;
    let mut cursor_data = Vec::new();
    for _ in 0..18 {
        cursor_data.extend([255, 0, 0, 0]);
    }
    cursor_data.extend([0x80, 0x80, 0x40, 0]);
    let client = apply(
        client,
        &mut peer,
        false,
        &[
            rectangle(8, 1, 9, 2, -239, &cursor_data),
            raw(0, 0, 1, 1, &[GREEN]),
        ],
    )
    .await;
    let cursor = client.cursor().unwrap();
    assert_eq!(
        (
            cursor.width,
            cursor.height,
            cursor.hotspot_x,
            cursor.hotspot_y
        ),
        (9, 2, 8, 1)
    );
    assert_eq!(cursor.pixels().len(), 18 * 4);
    for (index, pixel) in cursor.pixels().as_chunks::<4>().0.iter().enumerate() {
        assert_eq!(&pixel[..3], &[255, 0, 0]);
        assert_eq!(pixel[3], if [0, 8, 10].contains(&index) { 255 } else { 0 });
    }
    assert_eq!(
        client.pixels().unwrap(),
        GREEN,
        "cursor is separate from captured pixels"
    );
    let client = apply(client, &mut peer, true, &[rectangle(0, 0, 0, 0, -239, &[])]).await;
    assert!(client.cursor().is_none());
}

#[tokio::test]
async fn replacing_and_hiding_cursors_releases_their_retained_budget() {
    let (client, mut peer) = initialized(1, 1).await;
    let baseline = client.memory_usage().0;
    let mut cursor = Vec::new();
    for _ in 0..256 * 256 {
        cursor.extend([255, 0, 0, 0]);
    }
    cursor.extend([255; 256 * 32]);
    let client = apply(
        client,
        &mut peer,
        false,
        &[
            rectangle(0, 0, 256, 256, -239, &cursor),
            raw(0, 0, 1, 1, &[GREEN]),
        ],
    )
    .await;
    let with_large_cursor = client.memory_usage().0;
    assert!(with_large_cursor >= baseline + 256 * 256 * 4);
    let client = apply(
        client,
        &mut peer,
        true,
        &[rectangle(0, 0, 1, 1, -239, &[255, 0, 0, 0, 0x80])],
    )
    .await;
    assert!(client.memory_usage().0 < with_large_cursor);
    let client = apply(client, &mut peer, true, &[rectangle(0, 0, 0, 0, -239, &[])]).await;
    assert_eq!(client.memory_usage().0, baseline);
    assert!(client.memory_usage().1 <= 128 * 1024 * 1024);
    assert_eq!(client.pixels().unwrap(), GREEN);
}

#[tokio::test]
async fn skips_bell_and_bounded_cut_text_without_disrupting_the_update() {
    let (client, mut peer) = initialized(1, 1).await;
    let mut bytes = vec![2, 3, 0, 0, 0];
    bytes.extend(4_u32.to_be_bytes());
    bytes.extend(b"text");
    bytes.extend(update_message(&[raw(0, 0, 1, 1, &[BLUE])]));
    let client = apply_bytes(client, &mut peer, false, &bytes).await.unwrap();
    assert_eq!(client.pixels().unwrap(), BLUE);
    assert_eq!(client.update_sequence(), 1);
}

#[tokio::test]
async fn rejects_unknown_messages_encodings_and_out_of_bounds_rectangles() {
    let cases = [
        (vec![99], "message"),
        (update_message(&[rectangle(0, 0, 1, 1, 7, &[])]), "encoding"),
        (
            update_message(&[rectangle(65535, 0, 1, 1, 0, &[])]),
            "rectangle",
        ),
        (
            update_message(&[rectangle(0, 0, 2, 1, 0, &[])]),
            "rectangle",
        ),
        (update_message(&[copy_rect(0, 0, 1, 1, 1, 0)]), "rectangle"),
        (
            update_message(&[rectangle(0, 0, 8193, 1, -223, &[])]),
            "rectangle",
        ),
        (
            update_message(&[rectangle(0, 0, 257, 1, -239, &[])]),
            "resource",
        ),
        (vec![0, 0, 0x10, 1], "resource"),
        (vec![3, 0, 0, 0, 0, 0, 0x10, 1], "resource"),
        (
            update_message(&[rectangle(0, 0, 1, 1, 16, &41_943_041_u32.to_be_bytes())]),
            "resource",
        ),
    ];
    for (message, kind) in cases {
        let (client, mut peer) = initialized(1, 1).await;
        let failure = error(apply_bytes(client, &mut peer, false, &message).await);
        match kind {
            "message" => assert!(matches!(failure, Error::UnsupportedMessage)),
            "encoding" => assert!(matches!(failure, Error::UnsupportedEncoding)),
            "resource" => assert!(matches!(failure, Error::ResourceLimit)),
            _ => assert!(matches!(
                failure,
                Error::InvalidFramebuffer | Error::ResourceLimit
            )),
        }
        disconnected(&mut peer).await;
    }
}

#[tokio::test]
async fn rejects_malformed_zrle_without_returning_a_partially_updated_frame() {
    let cases = [
        vec![17],
        vec![129],
        vec![0, 255, 0],       // Missing the blue byte of a raw CPIXEL.
        vec![1, 255, 0, 0, 0], // A complete tile followed by extra decoded data.
        vec![3, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0xc0], // Palette index 3 >= size 3.
        vec![128, 255, 0, 0, 1], // Two-pixel run in a one-pixel tile.
        vec![128, 255, 0, 0, 255], // Run continuation never terminates.
        vec![130, 255, 0, 0, 0, 0, 255, 2], // Invalid palette-RLE index.
    ];
    for tile in cases {
        let (client, mut peer) = initialized(1, 1).await;
        let message = update_message(&[
            raw(0, 0, 1, 1, &[GREEN]),
            zrle(0, 0, 1, 1, &compress(&tile)),
        ]);
        assert!(matches!(
            error(apply_bytes(client, &mut peer, false, &message).await),
            Error::InvalidCompressedData
        ));
        disconnected(&mut peer).await;
    }
    let (client, mut peer) = initialized(1, 1).await;
    let message = update_message(&[zrle(0, 0, 1, 1, b"invalid zlib")]);
    assert!(matches!(
        error(apply_bytes(client, &mut peer, false, &message).await),
        Error::InvalidCompressedData
    ));
    disconnected(&mut peer).await;
}

#[tokio::test]
async fn rejects_compressed_output_bombs_before_retaining_unbounded_data() {
    let (client, mut peer) = initialized(1, 1).await;
    let compressed = compress(&vec![0; 1024 * 1024]);
    assert!(compressed.len() < 16 * 1024);
    let message = update_message(&[zrle(0, 0, 1, 1, &compressed)]);
    assert!(matches!(
        error(apply_bytes(client, &mut peer, false, &message).await),
        Error::ResourceLimit | Error::InvalidCompressedData
    ));
    disconnected(&mut peer).await;
}

#[tokio::test]
async fn rejects_truncated_initialization_and_framebuffer_wire_data() {
    let (client, mut peer) = authenticated().await;
    let caller = client.initialize(deadline());
    let server = async {
        assert_eq!(peer.read_u8().await.unwrap(), 1);
        peer.write_all(&[0, 1, 0]).await.unwrap();
        peer.shutdown().await.unwrap();
    };
    let (result, ()) = bounded(async { tokio::join!(caller, server) }).await;
    assert!(matches!(error(result), Error::Io(_)));

    for message in [
        vec![0, 0, 0],
        update_message(&[rectangle(0, 0, 1, 1, 0, &[255, 0])]),
        update_message(&[rectangle(0, 0, 1, 1, 16, &[0, 0, 0, 5, 0x78, 0x9c])]),
    ] {
        let (client, mut peer) = initialized(1, 1).await;
        let caller = client.update(false, deadline());
        let server = async {
            read_request(&mut peer, false, 1, 1).await;
            peer.write_all(&message).await.unwrap();
            peer.shutdown().await.unwrap();
        };
        let (result, ()) = bounded(async { tokio::join!(caller, server) }).await;
        assert!(matches!(error(result), Error::Io(_)));
    }
}

#[tokio::test]
async fn cancels_initialization_and_update_by_dropping_the_owned_future() {
    let (client, mut peer) = authenticated().await;
    {
        let pending = client.initialize(deadline());
        tokio::pin!(pending);
        bounded(async {
            tokio::select! {
                result = &mut pending => panic!("initialization unexpectedly completed: {:?}", result.err()),
                byte = peer.read_u8() => assert_eq!(byte.unwrap(), 1),
            }
        }).await;
    }
    disconnected(&mut peer).await;

    let (client, mut peer) = initialized(1, 1).await;
    {
        let pending = client.update(false, deadline());
        tokio::pin!(pending);
        bounded(async {
            tokio::select! {
                result = &mut pending => panic!("update unexpectedly completed: {:?}", result.err()),
                () = read_request(&mut peer, false, 1, 1) => {},
            }
        }).await;
    }
    disconnected(&mut peer).await;
}

#[tokio::test]
async fn deadline_failure_closes_the_socket_before_or_during_a_stalled_update() {
    let (client, mut peer) = initialized(1, 1).await;
    assert!(matches!(
        error(client.update(false, Instant::now()).await),
        Error::DeadlineExceeded
    ));
    disconnected(&mut peer).await;

    let (client, mut peer) = initialized(1, 1).await;
    let caller = client.update(false, Instant::now() + Duration::from_millis(100));
    let server = async {
        read_request(&mut peer, false, 1, 1).await;
        disconnected(&mut peer).await;
    };
    let (result, ()) = bounded(async { tokio::join!(caller, server) }).await;
    assert!(matches!(error(result), Error::DeadlineExceeded));
}

#[tokio::test]
async fn a_ready_update_cannot_escape_the_deadline_when_polling_resumes_late() {
    let (client, mut peer) = initialized(1, 1).await;
    let end = Instant::now() + Duration::from_millis(100);
    {
        let pending = client.update(false, end);
        tokio::pin!(pending);
        bounded(async {
            tokio::select! {
                result = &mut pending => panic!("update completed before its response: {:?}", result.err()),
                () = read_request(&mut peer, false, 1, 1) => {},
            }
        })
        .await;
        peer.write_all(&update_message(&[raw(0, 0, 1, 1, &[RED])]))
            .await
            .unwrap();
        peer.flush().await.unwrap();
        // The real deadline is the condition under test. Deliberately leave the
        // response future unpolled until then; this is not a readiness delay.
        tokio::time::sleep_until(end).await;
        assert!(matches!(error(pending.await), Error::DeadlineExceeded));
    }
    disconnected(&mut peer).await;
}

#[tokio::test]
async fn maximum_geometry_decodes_within_the_retained_memory_budget() {
    let (client, mut peer) = initialized(8192, 1024).await;
    let (initial, initial_peak) = client.memory_usage();
    assert!(initial >= 8_388_608 * 4);
    assert!(initial <= initial_peak);
    assert!(initial_peak <= 128 * 1024 * 1024);
    // 128 by 16 solid tiles cover the largest allowed framebuffer using a small
    // wire payload while still requiring every decoded pixel and coverage bit.
    let mut tiles = Vec::new();
    for _ in 0..128 * 16 {
        tiles.extend([1, 255, 0, 0]);
    }
    let client = apply(
        client,
        &mut peer,
        false,
        &[zrle(0, 0, 8192, 1024, &compress(&tiles))],
    )
    .await;
    assert_eq!(client.pixels().unwrap().len(), 8_388_608 * 4);
    assert!(
        client
            .pixels()
            .unwrap()
            .as_chunks::<4>()
            .0
            .iter()
            .all(|pixel| *pixel == RED)
    );
    let (current, peak) = client.memory_usage();
    assert!(current >= initial);
    assert!(current <= peak);
    assert!(peak <= 128 * 1024 * 1024);
    eprintln!(
        "maximum framebuffer: retained={current}, peak={peak}, budget={}",
        128 * 1024 * 1024
    );
    drop(client);
    disconnected(&mut peer).await;
}

#[tokio::test]
async fn rejects_cumulative_wire_bytes_before_reading_the_next_raw_payload() {
    let (client, mut peer) = initialized(8192, 1024).await;
    let caller = client.update(false, deadline());
    let server = async {
        read_request(&mut peer, false, 8192, 1024).await;
        peer.write_all(&[0, 0, 0, 2]).await.unwrap();
        let header = rectangle(0, 0, 8192, 1024, 0, &[]);
        peer.write_all(&header).await.unwrap();
        // Reuse one heap-backed row instead of building a 32 MiB fixture. Two
        // full Raw payloads plus update/rectangle headers exceed the 64 MiB cap.
        let row = [255, 0, 0, 0].repeat(8192);
        for _ in 0..1024 {
            peer.write_all(&row).await.unwrap();
        }
        peer.write_all(&header).await.unwrap();
        peer.flush().await.unwrap();
        // Withhold the entire second payload. The decoder must reject its
        // declared size immediately, rather than allocate or await those bytes.
        disconnected(&mut peer).await;
    };
    let (result, ()) = bounded(async { tokio::join!(caller, server) }).await;
    assert!(matches!(error(result), Error::ResourceLimit));
}

#[tokio::test]
async fn bounds_bell_chatter_without_waiting_for_another_server_message() {
    let (client, mut peer) = initialized(1, 1).await;
    let result = apply_bytes(client, &mut peer, false, &[2; 64]).await;
    assert!(matches!(error(result), Error::ResourceLimit));
    disconnected(&mut peer).await;
}

#[tokio::test]
async fn decodes_high_entropy_4k_zrle_within_the_framebuffer_memory_budget() {
    fn color(index: usize) -> [u8; 3] {
        // Deterministic avalanche mixing produces incompressible fixture pixels
        // without random seeds or reliance on any production pixel conversion.
        let mut value = (index as u32).wrapping_add(0x9e37_79b9);
        value = (value ^ (value >> 16)).wrapping_mul(0x85eb_ca6b);
        value = (value ^ (value >> 13)).wrapping_mul(0xc2b2_ae35);
        value ^= value >> 16;
        [value as u8, (value >> 8) as u8, (value >> 16) as u8]
    }

    const WIDTH: usize = 3840;
    const HEIGHT: usize = 2160;
    let mut tiles =
        Vec::with_capacity(WIDTH * HEIGHT * 3 + WIDTH.div_ceil(64) * HEIGHT.div_ceil(64));
    for tile_y in (0..HEIGHT).step_by(64) {
        for tile_x in (0..WIDTH).step_by(64) {
            tiles.push(0); // Raw ZRLE tile, with three-byte RGB CPIXEL values.
            for y in tile_y..(tile_y + 64).min(HEIGHT) {
                for x in tile_x..(tile_x + 64).min(WIDTH) {
                    tiles.extend(color(y * WIDTH + x));
                }
            }
        }
    }
    let mut compressed = compress(&tiles);
    drop(tiles);
    compressed.shrink_to_fit();
    assert!(compressed.len() > 16 * 1024 * 1024);

    // Fixture generation and compression precede the operation's real deadline.
    let (client, mut peer) = initialized(WIDTH as u16, HEIGHT as u16).await;
    let caller = client.update(false, deadline());
    let server = async {
        read_request(&mut peer, false, WIDTH as u16, HEIGHT as u16).await;
        peer.write_all(&[0, 0, 0, 1]).await?;
        let length = u32::try_from(compressed.len()).unwrap().to_be_bytes();
        let header = rectangle(0, 0, WIDTH as u16, HEIGHT as u16, 16, &length);
        peer.write_all(&header).await?;
        // Stream the existing compressed allocation directly; zrle() and
        // update_message() would each copy this large fixture into another Vec.
        peer.write_all(&compressed).await?;
        peer.flush().await?;
        Ok::<(), std::io::Error>(())
    };
    let (result, sent) = bounded(async { tokio::join!(caller, server) }).await;
    let client = result.unwrap();
    sent.unwrap();
    let output = client.pixels().unwrap();
    assert_eq!(output.len(), WIDTH * HEIGHT * 4);
    for (index, pixel) in output.as_chunks::<4>().0.iter().enumerate() {
        let rgb = color(index);
        assert_eq!(*pixel, [rgb[0], rgb[1], rgb[2], 255]);
    }
    let (current, peak) = client.memory_usage();
    assert!(current <= peak);
    assert!(peak <= 128 * 1024 * 1024);
    eprintln!(
        "high-entropy 4K ZRLE: compressed={}, retained={current}, peak={peak}",
        compressed.len()
    );
    drop(client);
    disconnected(&mut peer).await;
}
