#![cfg(test)]

pub mod common_framebuffer;

use std::{
    future::Future,
    io::Cursor as IoCursor,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll, Waker},
    time::SystemTime,
};

use common_framebuffer::*;
use rfb_client::{
    Capture, Error, Input, InputOutcome, Key, MouseButton, ScrollAxis, Session, SharingMode,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::TcpStream,
    sync::Notify,
    time::Instant,
};

fn decode(capture: &Capture) -> Vec<u8> {
    let mut reader = png::Decoder::new(IoCursor::new(capture.png()))
        .read_info()
        .unwrap();
    let mut output = vec![0; reader.output_buffer_size().unwrap()];
    let frame = reader.next_frame(&mut output).unwrap();
    assert_eq!(frame.color_type, png::ColorType::Rgba);
    assert_eq!(frame.bit_depth, png::BitDepth::Eight);
    assert_eq!(frame.width, u32::from(capture.metadata().width));
    assert_eq!(frame.height, u32::from(capture.metadata().height));
    output.truncate(frame.buffer_size());
    output
}

async fn send_update(peer: &mut Peer, rectangles: &[Vec<u8>]) {
    peer.write_all(&update_message(rectangles)).await.unwrap();
    peer.flush().await.unwrap();
}

async fn capture_frame(
    session: &mut Session<TcpStream>,
    peer: &mut Peer,
    width: u16,
    height: u16,
    rectangles: &[Vec<u8>],
) -> Capture {
    let server = async {
        read_request(peer, false, width, height).await;
        send_update(peer, rectangles).await;
    };
    let (capture, ()) = bounded(async { tokio::join!(session.capture(deadline()), server) }).await;
    capture.unwrap()
}

fn key(down: bool, keysym: u32) -> Vec<u8> {
    let mut bytes = vec![4, u8::from(down), 0, 0];
    bytes.extend(keysym.to_be_bytes());
    bytes
}

fn pointer(mask: u8, x: u16, y: u16) -> Vec<u8> {
    let mut bytes = vec![5, mask];
    bytes.extend(x.to_be_bytes());
    bytes.extend(y.to_be_bytes());
    bytes
}

async fn expect_input(peer: &mut Peer, expected: &[Vec<u8>]) {
    let expected: Vec<_> = expected.iter().flatten().copied().collect();
    let mut actual = vec![0; expected.len()];
    peer.read_exact(&mut actual).await.unwrap();
    assert_eq!(actual, expected);
}

#[tokio::test]
async fn captures_fresh_partial_frames_and_retains_immutable_png_and_cursor_snapshots() {
    let (client, mut peer) = initialized(2, 1).await;
    let mut session = Session::new(client);
    let initial_geometry = session.geometry().unwrap();
    let before = SystemTime::now();
    let first = capture_frame(
        &mut session,
        &mut peer,
        2,
        1,
        &[
            raw(0, 0, 2, 1, &[RED, BLUE]),
            rectangle(0, 0, 1, 1, -239, &[255, 255, 255, 0, 0x80]),
        ],
    )
    .await;
    assert_eq!(decode(&first), pixels(&[RED, BLUE]));
    assert_eq!(first.metadata().geometry, initial_geometry);
    assert_eq!(first.metadata().update_sequence, 1);
    assert!(first.metadata().captured_at >= before);
    assert!(first.metadata().captured_at <= SystemTime::now());
    assert_eq!(first.cursor().unwrap().pixels(), WHITE);
    let first_png = first.png().to_vec();

    let server = async {
        read_request(&mut peer, false, 2, 1).await;
        send_update(&mut peer, &[raw(0, 0, 1, 1, &[GREEN])]).await;
        read_request(&mut peer, true, 2, 1).await;
        send_update(
            &mut peer,
            &[raw(1, 0, 1, 1, &[BLACK]), rectangle(0, 0, 0, 0, -239, &[])],
        )
        .await;
    };
    let (second, ()) = bounded(async { tokio::join!(session.capture(deadline()), server) }).await;
    let second = second.unwrap();
    assert_eq!(decode(&second), pixels(&[GREEN, BLACK]));
    assert_eq!(second.metadata().update_sequence, 3);
    assert_eq!(second.metadata().geometry, initial_geometry);
    assert!(second.cursor().is_none());
    assert_eq!(first.png(), first_png);
    assert_eq!(first.cursor().unwrap().pixels(), WHITE);

    session.close();
    disconnected(&mut peer).await;
    let retained = session.memory_usage().0;
    assert!(retained >= first.png().len() + second.png().len() + WHITE.len());
    assert!(session.memory_usage().1 <= 128 * 1024 * 1024);
    drop(first);
    assert!(session.memory_usage().0 < retained);
    assert_eq!(decode(&second), pixels(&[GREEN, BLACK]));
    drop(second);
    assert_eq!(session.memory_usage().0, 0);
}

#[tokio::test]
async fn capture_restarts_full_coverage_after_resize_and_returns_new_geometry() {
    let (client, mut peer) = initialized(1, 1).await;
    let mut session = Session::new(client);
    let initial_geometry = session.geometry().unwrap();
    let server = async {
        read_request(&mut peer, false, 1, 1).await;
        send_update(
            &mut peer,
            &[
                raw(0, 0, 1, 1, &[RED]),
                rectangle(0, 0, 2, 1, -223, &[]),
                raw(0, 0, 1, 1, &[GREEN]),
            ],
        )
        .await;
        read_request(&mut peer, false, 2, 1).await;
        send_update(&mut peer, &[raw(0, 0, 1, 1, &[BLUE])]).await;
        read_request(&mut peer, true, 2, 1).await;
        send_update(&mut peer, &[raw(1, 0, 1, 1, &[WHITE])]).await;
    };
    let (capture, ()) = bounded(async { tokio::join!(session.capture(deadline()), server) }).await;
    let capture = capture.unwrap();
    assert_eq!(decode(&capture), pixels(&[BLUE, WHITE]));
    assert_eq!(capture.metadata().update_sequence, 3);
    assert_eq!(
        capture.metadata().geometry.session_id,
        initial_geometry.session_id
    );
    assert!(capture.metadata().geometry.epoch > initial_geometry.epoch);
    assert_eq!(Some(capture.metadata().geometry), session.geometry());
}

#[tokio::test]
async fn incomplete_capture_stops_after_the_response_limit_and_releases_connection() {
    let (client, mut peer) = initialized(1, 1).await;
    let mut session = Session::new(client);
    let server = async {
        for response in 0..64 {
            read_request(&mut peer, response != 0, 1, 1).await;
            send_update(&mut peer, &[]).await;
        }
        disconnected(&mut peer).await;
    };
    let (result, ()) = bounded(async { tokio::join!(session.capture(deadline()), server) }).await;
    assert!(matches!(error(result), Error::ResourceLimit));
    assert!(session.is_closed());
    assert_eq!(session.memory_usage().0, 0);
}

#[tokio::test]
async fn text_maps_unicode_and_named_controls_to_balanced_key_events() {
    let (client, mut peer) = initialized(1, 1).await;
    let mut session = Session::new(client);
    let mut expected = Vec::new();
    for keysym in [0x41, 0xe9, 0x0100_4e2d, 0x0101_f642, 0xff0d, 0xff09] {
        expected.push(key(true, keysym));
        expected.push(key(false, keysym));
    }
    let mut outcome = InputOutcome::default();
    let (result, ()) = bounded(async {
        tokio::join!(
            session.input(Input::Text("Aé中🙂\n\t"), &mut outcome, deadline()),
            expect_input(&mut peer, &expected)
        )
    })
    .await;
    result.unwrap();
    assert_eq!(outcome, InputOutcome::Sent);
    session.close();
    disconnected(&mut peer).await;
}

#[tokio::test]
async fn key_chords_release_in_reverse_order_before_the_next_operation() {
    let (client, mut peer) = initialized(1, 1).await;
    let mut session = Session::new(client);
    let mut outcome = InputOutcome::default();
    let expected = [
        key(true, 0xffe3),
        key(true, 0xffe1),
        key(true, 0x7a),
        key(false, 0x7a),
        key(false, 0xffe1),
        key(false, 0xffe3),
        key(true, 0xff0d),
        key(false, 0xff0d),
    ];
    let caller = async {
        session
            .input(
                Input::KeyChord(&[Key::Control, Key::Shift, Key::Character('z')]),
                &mut outcome,
                deadline(),
            )
            .await
            .unwrap();
        assert_eq!(outcome, InputOutcome::Sent);
        session
            .input(Input::KeyChord(&[Key::Enter]), &mut outcome, deadline())
            .await
            .unwrap();
    };
    bounded(async { tokio::join!(caller, expect_input(&mut peer, &expected)) }).await;
    assert_eq!(outcome, InputOutcome::Sent);
    session.close();
    disconnected(&mut peer).await;
}

#[tokio::test]
async fn pointer_operations_refresh_then_emit_balanced_click_drag_and_scroll() {
    let (client, mut peer) = initialized(3, 2).await;
    let mut session = Session::new(client);
    let capture = capture_frame(
        &mut session,
        &mut peer,
        3,
        2,
        &[raw(0, 0, 3, 2, &[BLACK; 6])],
    )
    .await;
    let geometry = capture.metadata().geometry;
    let points = [(0, 0), (1, 1), (2, 1)];
    let cases = [
        (
            Input::Click {
                geometry,
                x: 2,
                y: 1,
                button: MouseButton::Right,
            },
            vec![pointer(4, 2, 1), pointer(0, 2, 1)],
        ),
        (
            Input::Drag {
                geometry,
                points: &points,
                button: MouseButton::Left,
            },
            vec![
                pointer(1, 0, 0),
                pointer(1, 1, 1),
                pointer(1, 2, 1),
                pointer(0, 2, 1),
            ],
        ),
        (
            Input::Scroll {
                geometry,
                x: 1,
                y: 0,
                axis: ScrollAxis::Vertical,
                steps: -2,
            },
            vec![
                pointer(8, 1, 0),
                pointer(0, 1, 0),
                pointer(8, 1, 0),
                pointer(0, 1, 0),
            ],
        ),
        (
            Input::Scroll {
                geometry,
                x: 1,
                y: 1,
                axis: ScrollAxis::Horizontal,
                steps: 1,
            },
            vec![pointer(64, 1, 1), pointer(0, 1, 1)],
        ),
    ];
    for (command, expected) in cases {
        let mut outcome = InputOutcome::default();
        let server = async {
            read_request(&mut peer, false, 3, 2).await;
            send_update(&mut peer, &[raw(0, 0, 3, 2, &[WHITE; 6])]).await;
            expect_input(&mut peer, &expected).await;
        };
        let (result, ()) = bounded(async {
            tokio::join!(session.input(command, &mut outcome, deadline()), server)
        })
        .await;
        result.unwrap();
        assert_eq!(outcome, InputOutcome::Sent);
    }
    session.close();
    disconnected(&mut peer).await;
}

#[tokio::test]
async fn invalid_operations_are_rejected_in_full_before_any_io_and_preserve_session() {
    let (client, mut peer) = initialized(2, 1).await;
    let mut session = Session::new(client);
    let geometry = session.geometry().unwrap();
    let too_many_events = "a".repeat(2049);
    let too_many_bytes = "中".repeat(1366);
    let commands = [
        Input::Text("valid prefix\u{1}"),
        Input::Text(&too_many_events),
        Input::Text(&too_many_bytes),
        Input::KeyChord(&[Key::Control, Key::Character('a'), Key::Control]),
        Input::KeyChord(&[Key::Shift, Key::Function(36)]),
        Input::Drag {
            geometry,
            points: &[(0, 0), (2, 0)],
            button: MouseButton::Left,
        },
        Input::Scroll {
            geometry,
            x: 0,
            y: 0,
            axis: ScrollAxis::Vertical,
            steps: i16::MIN,
        },
    ];
    let baseline = session.memory_usage().0;
    for command in commands {
        let mut outcome = InputOutcome::Sent;
        assert!(matches!(
            error(session.input(command, &mut outcome, deadline()).await),
            Error::InvalidInput
        ));
        assert_eq!(outcome, InputOutcome::NotStarted);
        assert!(!session.is_closed());
        assert_eq!(session.memory_usage().0, baseline);
    }
    // The peer's very next bytes must be a capture request, proving no valid
    // prefix of any rejected operation escaped onto the wire.
    let capture = capture_frame(
        &mut session,
        &mut peer,
        2,
        1,
        &[raw(0, 0, 2, 1, &[RED, BLUE])],
    )
    .await;
    assert_eq!(decode(&capture), pixels(&[RED, BLUE]));
}

#[tokio::test]
async fn geometry_from_another_session_is_rejected_before_refresh() {
    let (first_client, mut first_peer) = initialized(1, 1).await;
    let first = Session::new(first_client);
    let other_geometry = first.geometry().unwrap();
    let (client, mut peer) = initialized(1, 1).await;
    let mut session = Session::new(client);
    assert_ne!(
        session.geometry().unwrap().session_id,
        other_geometry.session_id
    );
    let mut outcome = InputOutcome::default();
    let result = session
        .input(
            Input::Click {
                geometry: other_geometry,
                x: 0,
                y: 0,
                button: MouseButton::Left,
            },
            &mut outcome,
            deadline(),
        )
        .await;
    assert!(matches!(error(result), Error::StaleGeometry));
    assert_eq!(outcome, InputOutcome::NotStarted);
    assert!(!session.is_closed());
    let capture = capture_frame(&mut session, &mut peer, 1, 1, &[raw(0, 0, 1, 1, &[GREEN])]).await;
    assert_eq!(decode(&capture), GREEN);
    drop(first);
    disconnected(&mut first_peer).await;
}

#[tokio::test]
async fn resize_during_coordinate_refresh_rejects_input_and_closes_without_sending_it() {
    let (client, mut peer) = initialized(1, 1).await;
    let mut session = Session::new(client);
    let geometry = session.geometry().unwrap();
    let mut outcome = InputOutcome::default();
    let command = Input::Click {
        geometry,
        x: 0,
        y: 0,
        button: MouseButton::Left,
    };
    let server = async {
        read_request(&mut peer, false, 1, 1).await;
        send_update(&mut peer, &[rectangle(0, 0, 1, 1, -223, &[])]).await;
        read_request(&mut peer, false, 1, 1).await;
        send_update(&mut peer, &[raw(0, 0, 1, 1, &[GREEN])]).await;
        disconnected(&mut peer).await;
    };
    let (result, ()) =
        bounded(async { tokio::join!(session.input(command, &mut outcome, deadline()), server) })
            .await;
    assert!(matches!(error(result), Error::StaleGeometry));
    assert_eq!(outcome, InputOutcome::NotStarted);
    assert!(session.is_closed());
    assert_eq!(session.memory_usage().0, 0);
}

#[tokio::test]
async fn cancelling_capture_after_request_closes_and_releases_the_session() {
    let (client, mut peer) = initialized(1, 1).await;
    let mut session = Session::new(client);
    let mut capture = Box::pin(session.capture(deadline()));
    bounded(async {
        tokio::select! {
            result = &mut capture => panic!("capture completed without a server update: {}", result.is_ok()),
            () = read_request(&mut peer, false, 1, 1) => {}
        }
    }).await;
    drop(capture);
    assert!(session.is_closed());
    assert!(session.geometry().is_none());
    assert_eq!(session.memory_usage().0, 0);
    disconnected(&mut peer).await;
}

#[tokio::test]
async fn cancelling_coordinate_refresh_keeps_input_not_started_and_closes_session() {
    let (client, mut peer) = initialized(1, 1).await;
    let mut session = Session::new(client);
    let geometry = session.geometry().unwrap();
    let mut outcome = InputOutcome::Sent;
    let mut input = Box::pin(session.input(
        Input::Click {
            geometry,
            x: 0,
            y: 0,
            button: MouseButton::Left,
        },
        &mut outcome,
        deadline(),
    ));
    bounded(async {
        tokio::select! {
            result = &mut input => panic!("input completed without a server update: {result:?}"),
            () = read_request(&mut peer, false, 1, 1) => {}
        }
    })
    .await;
    drop(input);
    assert_eq!(outcome, InputOutcome::NotStarted);
    assert!(session.is_closed());
    assert_eq!(session.memory_usage().0, 0);
    disconnected(&mut peer).await;
}

#[tokio::test]
async fn cancelling_unpolled_input_resets_previous_delivery_without_touching_session() {
    let (client, mut peer) = initialized(1, 1).await;
    let mut session = Session::new(client);
    let mut outcome = InputOutcome::default();
    let expected = [key(true, u32::from('a')), key(false, u32::from('a'))];
    let (result, ()) = bounded(async {
        tokio::join!(
            session.input(Input::Text("a"), &mut outcome, deadline()),
            expect_input(&mut peer, &expected)
        )
    })
    .await;
    result.unwrap();
    assert_eq!(outcome, InputOutcome::Sent);

    // A ready cancellation branch can win before this future is ever polled.
    // The next operation must not inherit the previous operation's delivery.
    let pending = session.input(Input::Text("b"), &mut outcome, deadline());
    drop(pending);
    assert_eq!(outcome, InputOutcome::NotStarted);
    assert!(!session.is_closed());
    // The next wire message is exactly a framebuffer request, with no input
    // prefix from the abandoned operation, and the session remains usable.
    let capture = capture_frame(&mut session, &mut peer, 1, 1, &[raw(0, 0, 1, 1, &[GREEN])]).await;
    assert_eq!(decode(&capture), GREEN);
    session.close();
    disconnected(&mut peer).await;
}

#[tokio::test]
async fn cancellation_after_an_input_write_preserves_unknown_outcome_without_replaying() {
    let (client, mut peer) = initialized(1, 1).await;
    let mut session = Session::new(client);
    let mut outcome = InputOutcome::default();
    let mut input = Box::pin(session.input(Input::Text("abc"), &mut outcome, deadline()));
    let mut context = Context::from_waker(Waker::noop());
    assert!(input.as_mut().poll(&mut context).is_pending());
    drop(input);
    assert_eq!(outcome, InputOutcome::Unknown);
    assert!(session.is_closed());
    assert_eq!(session.memory_usage().0, 0);
    // TLS may have buffered the attempted key-down. Drain any accepted prefix;
    // closure is the guarantee, not successful delivery of a release on cancel.
    let mut accepted = Vec::new();
    let result = bounded(peer.read_to_end(&mut accepted)).await;
    if let Err(error) = result {
        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset
        ));
    }
    assert!(key(true, u32::from('a')).starts_with(&accepted));
    assert!(matches!(
        error(
            session
                .input(Input::Text("abc"), &mut outcome, deadline())
                .await
        ),
        Error::SessionClosed
    ));
    assert_eq!(outcome, InputOutcome::NotStarted);
}

#[tokio::test]
async fn expired_deadlines_close_before_io_and_explicit_close_is_idempotent() {
    let (client, mut peer) = initialized(1, 1).await;
    let mut session = Session::new(client);
    assert!(session.expires_at() > Instant::now());
    assert!(matches!(
        error(session.capture(Instant::now()).await),
        Error::DeadlineExceeded
    ));
    assert!(session.is_closed());
    assert_eq!(session.memory_usage().0, 0);
    disconnected(&mut peer).await;
    session.close();
    session.close();
    assert!(matches!(
        error(session.capture(deadline()).await),
        Error::SessionClosed
    ));
}

#[tokio::test]
async fn transport_loss_during_capture_closes_and_releases_framebuffer() {
    let (client, mut peer) = initialized(1, 1).await;
    let mut session = Session::new(client);
    let server = async move {
        read_request(&mut peer, false, 1, 1).await;
        drop(peer);
    };
    let (result, ()) = bounded(async { tokio::join!(session.capture(deadline()), server) }).await;
    assert!(matches!(error(result), Error::Io(_)));
    assert!(session.is_closed());
    assert_eq!(session.memory_usage().0, 0);
}

// Preserve real TCP, TLS and RFB negotiation while controlling only the socket
// write-readiness boundary. The gate closes after initialization, so a blocked
// operation proves application-input backpressure rather than handshake delay.
struct WriteGate {
    stream: TcpStream,
    blocked: Arc<AtomicBool>,
    attempted: Arc<Notify>,
}

impl AsyncRead for WriteGate {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(context, buffer)
    }
}

impl AsyncWrite for WriteGate {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        if self.blocked.load(Ordering::Relaxed) {
            self.attempted.notify_one();
            Poll::Pending
        } else {
            Pin::new(&mut self.stream).poll_write(context, bytes)
        }
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(context)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(context)
    }
}

#[tokio::test]
async fn cancelling_backpressured_input_closes_socket_and_keeps_delivery_unknown() {
    let blocked = Arc::new(AtomicBool::new(false));
    let attempted = Arc::new(Notify::new());
    let (client, mut peer) = authenticated_with(|stream| WriteGate {
        stream,
        blocked: blocked.clone(),
        attempted: attempted.clone(),
    })
    .await;
    let init = server_init(1, 1, RGBX, b"backpressure fixture");
    let (client, ()) = bounded(async {
        tokio::join!(
            client.initialize(SharingMode::Shared, deadline()),
            negotiate_framebuffer(&mut peer, &init, 1)
        )
    })
    .await;
    let mut session = Session::new(client.unwrap());
    blocked.store(true, Ordering::Relaxed);
    let mut outcome = InputOutcome::default();
    let mut input = Box::pin(session.input(Input::Text("abc"), &mut outcome, deadline()));
    bounded(async {
        tokio::select! {
            result = &mut input => panic!("input completed with a blocked socket: {result:?}"),
            () = attempted.notified() => {}
        }
    })
    .await;
    drop(input);
    assert_eq!(outcome, InputOutcome::Unknown);
    assert!(session.is_closed());
    assert_eq!(session.memory_usage().0, 0);
    disconnected(&mut peer).await;
}
