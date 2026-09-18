//! Explicit, pinned external-server acceptance. See tests/TIGERVNC.md.

use std::{io::Cursor as IoCursor, path::PathBuf, process::Stdio, time::Duration};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    process::{Child, ChildStdin, ChildStdout, Command},
    time::{Instant, timeout},
};

use crate::{
    Capture, Error, FramebufferConnection, Input, InputOutcome, Key, MouseButton, ScrollAxis,
    Session, SharingMode, TrustRoots, VncPassword, authenticate,
};

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(10)
}

struct Fixture {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    ready: Value,
    _directory: tempfile::TempDir,
}

impl Fixture {
    async fn start() -> Self {
        let script = std::env::var_os("RFB_TIGERVNC_FIXTURE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tigervnc.py")
            });
        let directory = tempfile::tempdir().unwrap();
        let mut child = Command::new("/usr/bin/python3")
            .arg(script)
            .arg(directory.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("install the pinned prerequisites in tests/TIGERVNC.md");
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut fixture = Self {
            child,
            input,
            output,
            ready: Value::Null,
            _directory: directory,
        };
        fixture.ready = fixture.read().await;
        assert_eq!(fixture.ready["ready"], true);
        assert_eq!(fixture.ready["version"], "1.13.1+dfsg-2build2");
        fixture
    }

    async fn read(&mut self) -> Value {
        let mut line = String::new();
        let length = timeout(Duration::from_secs(15), self.output.read_line(&mut line))
            .await
            .expect("fixture response deadline")
            .unwrap();
        assert!(length > 0, "fixture exited before replying");
        serde_json::from_str(&line).unwrap()
    }

    async fn command(&mut self, request: Value) -> Value {
        let mut line = serde_json::to_vec(&request).unwrap();
        line.push(b'\n');
        timeout(Duration::from_secs(5), async {
            self.input.write_all(&line).await.unwrap();
            self.input.flush().await.unwrap();
        })
        .await
        .unwrap();
        self.read().await
    }

    async fn connect(&self, encoding: i32) -> FramebufferConnection<TcpStream> {
        let port = self.ready["port"].as_u64().unwrap() as u16;
        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.set_nodelay(true).unwrap();
        let certificate = std::fs::read(self.ready["ca_der"].as_str().unwrap()).unwrap();
        let authenticated = authenticate(
            stream,
            "localhost",
            VncPassword::new("testpass".to_owned()).unwrap(),
            TrustRoots::custom(vec![certificate.into()]).unwrap(),
            deadline(),
        )
        .await
        .unwrap();
        let mut connection = authenticated
            .initialize(SharingMode::Shared, deadline())
            .await
            .unwrap();
        // A module-private adapter forces each production decoder against the
        // independent server without adding encoder controls to the public API.
        let encodings = [encoding, 1, -239, -223];
        let mut message = vec![2, 0, 0, 4];
        for value in encodings {
            message.extend_from_slice(&value.to_be_bytes());
        }
        connection.stream.write_all(&message).await.unwrap();
        connection.stream.flush().await.unwrap();
        connection
    }

    async fn stop(mut self) {
        assert_eq!(
            self.command(json!({"command": "stop"})).await["stopped"],
            true
        );
        assert!(
            timeout(Duration::from_secs(10), self.child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
    }
}

fn rgba(capture: &Capture) -> Vec<u8> {
    let mut reader = png::Decoder::new(IoCursor::new(capture.png()))
        .read_info()
        .unwrap();
    let mut output = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut output).unwrap();
    assert_eq!(info.color_type, png::ColorType::Rgba);
    assert_eq!(info.bit_depth, png::BitDepth::Eight);
    assert_eq!(info.width, u32::from(capture.metadata().width));
    assert_eq!(info.height, u32::from(capture.metadata().height));
    output.truncate(info.buffer_size());
    output
}

fn pixel(bytes: &[u8], width: usize, x: usize, y: usize) -> &[u8] {
    let offset = (y * width + x) * 4;
    &bytes[offset..offset + 4]
}

async fn input(session: &mut Session<TcpStream>, command: Input<'_>) {
    let mut outcome = InputOutcome::NotStarted;
    session
        .input(command, &mut outcome, deadline())
        .await
        .unwrap();
    assert_eq!(outcome, InputOutcome::Sent);
}

async fn buttons(fixture: &mut Fixture, expected: usize) -> Vec<Value> {
    fixture
        .command(json!({"command": "wait_events", "types": [4,5], "count": expected}))
        .await["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == 4 || event["type"] == 5)
        .cloned()
        .collect()
}

#[tokio::test]
#[ignore = "requires pinned TigerVNC/X11 tools; run the explicit command in tests/TIGERVNC.md"]
async fn pinned_tigervnc_session_acceptance() {
    timeout(Duration::from_secs(120), run_matrix())
        .await
        .expect("complete TigerVNC acceptance deadline");
}

async fn run_matrix() {
    for encoding in [16, 0] {
        let mut fixture = Fixture::start().await;
        let mut connection = fixture
            .connect(encoding)
            .await
            .update(false, deadline())
            .await
            .unwrap();
        assert_eq!((connection.width(), connection.height()), (320, 240));
        assert!(
            connection
                .pixels()
                .unwrap()
                .as_chunks::<4>()
                .0
                .iter()
                .all(|p| *p == [17, 34, 51, 255])
        );

        fixture
            .command(json!({"command": "paint", "rgb": 0xff0000, "rect": [0,0,80,80]}))
            .await;
        connection = connection.update(true, deadline()).await.unwrap();
        assert_eq!(
            pixel(connection.pixels().unwrap(), 320, 10, 10),
            [255, 0, 0, 255]
        );
        fixture
            .command(json!({"command": "copy", "rect": [0,0,80,80], "destination": [100,100]}))
            .await;
        connection = connection.update(true, deadline()).await.unwrap();
        assert_eq!(
            pixel(connection.pixels().unwrap(), 320, 110, 110),
            [255, 0, 0, 255]
        );

        let mut session = Session::new(connection);
        let first = session.capture(deadline()).await.unwrap();
        let geometry = first.metadata().geometry;
        let before = rgba(&first);
        assert_eq!(pixel(&before, 320, 250, 200), [17, 34, 51, 255]);
        assert_eq!(pixel(&before, 320, 110, 110), [255, 0, 0, 255]);

        input(&mut session, Input::Text("a中文")).await;
        let events = fixture
            .command(json!({"command":"wait_events", "kind":"key", "count":6}))
            .await;
        let keys: Vec<_> = events["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["kind"] == "key")
            .map(|event| {
                (
                    event["keysym"].as_u64().unwrap(),
                    event["down"].as_bool().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            keys,
            [
                (97, true),
                (97, false),
                (0x01004e2d, true),
                (0x01004e2d, false),
                (0x01006587, true),
                (0x01006587, false)
            ]
        );

        input(
            &mut session,
            Input::KeyChord(&[Key::Control, Key::Character('a')]),
        )
        .await;
        let events = fixture
            .command(json!({"command":"wait_events", "kind":"key", "count":4}))
            .await;
        let keys: Vec<_> = events["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["kind"] == "key")
            .map(|event| {
                (
                    event["keysym"].as_u64().unwrap(),
                    event["down"].as_bool().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            keys,
            [(0xffe3, true), (97, true), (97, false), (0xffe3, false)]
        );

        input(
            &mut session,
            Input::Click {
                geometry,
                x: 50,
                y: 60,
                button: MouseButton::Left,
            },
        )
        .await;
        let events = buttons(&mut fixture, 2).await;
        assert_eq!(events.len(), 2);
        assert_eq!(
            (events[0]["type"].as_u64(), events[1]["type"].as_u64()),
            (Some(4), Some(5))
        );
        assert!(
            events
                .iter()
                .all(|event| event["button"] == 1 && event["x"] == 50 && event["y"] == 60)
        );

        input(
            &mut session,
            Input::Drag {
                geometry,
                points: &[(10, 10), (20, 20), (30, 30)],
                button: MouseButton::Left,
            },
        )
        .await;
        let events = buttons(&mut fixture, 2).await;
        assert_eq!(
            (events[0]["x"].as_u64(), events[0]["y"].as_u64()),
            (Some(10), Some(10))
        );
        assert_eq!(
            (events[1]["x"].as_u64(), events[1]["y"].as_u64()),
            (Some(30), Some(30))
        );

        input(
            &mut session,
            Input::Scroll {
                geometry,
                x: 50,
                y: 60,
                axis: ScrollAxis::Vertical,
                steps: -2,
            },
        )
        .await;
        let events = buttons(&mut fixture, 4).await;
        assert_eq!(events.len(), 4);
        assert!(events.iter().all(|event| event["button"] == 4));

        fixture.command(json!({"command":"cursor"})).await;
        let with_cursor = session.capture(deadline()).await.unwrap();
        let cursor = with_cursor.cursor().expect("custom X11 cursor shape");
        assert_eq!(
            (
                cursor.width,
                cursor.height,
                cursor.hotspot_x,
                cursor.hotspot_y
            ),
            (4, 4, 1, 1)
        );
        assert!(
            cursor
                .pixels()
                .as_chunks::<4>()
                .0
                .iter()
                .all(|p| *p == [255, 0, 0, 255])
        );
        assert_eq!(
            rgba(&with_cursor),
            before,
            "PNG must exclude cursor composition"
        );

        fixture
            .command(json!({"command":"resize", "size":"640x480"}))
            .await;
        let resized = session.capture(deadline()).await.unwrap();
        assert_eq!(
            (resized.metadata().width, resized.metadata().height),
            (640, 480)
        );
        assert!(resized.metadata().geometry.epoch > geometry.epoch);
        let mut outcome = InputOutcome::Unknown;
        assert!(matches!(
            session
                .input(
                    Input::Click {
                        geometry,
                        x: 50,
                        y: 60,
                        button: MouseButton::Left
                    },
                    &mut outcome,
                    deadline()
                )
                .await,
            Err(Error::StaleGeometry)
        ));
        assert_eq!(outcome, InputOutcome::NotStarted);
        assert!(
            !session.is_closed(),
            "preflight rejection keeps healthy session"
        );
        session.close();
        let log = fixture.command(json!({"command":"closed"})).await;
        let log = log["log"].as_str().unwrap();
        assert!(log.contains("Client requests security type X509Vnc (261)"));
        assert!(
            log.contains("EncodeManager:   CopyRect:"),
            "must observe real CopyRect: {log}"
        );
        let name = if encoding == 16 { "ZRLE" } else { "Raw" };
        assert!(
            log.contains(&format!("EncodeManager:   {name}:")),
            "must observe {name}: {log}"
        );
        println!(
            "TigerVNC 1.13.1 {name}/CopyRect: PNG, ASCII/Chinese, chord, click, drag, wheel, cursor, resize, stale geometry and disconnect passed"
        );
        fixture.stop().await;
    }
}
