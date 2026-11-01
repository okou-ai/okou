use std::{
    io::{self, Cursor},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};

use tokio::{
    io::{AsyncRead, ReadBuf},
    sync::{Barrier, Notify, mpsc},
};

use super::*;

// Turn early admission of the queued third part into a synchronous failure,
// so the absence assertion does not depend on executor timing.
struct WindowGuardReader {
    inner: Cursor<Vec<u8>>,
    blocked_at: u64,
    queued_read_allowed: Arc<AtomicBool>,
    blocked_read_attempts: usize,
}

impl AsyncRead for WindowGuardReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.inner.position() >= self.blocked_at
            && !self.queued_read_allowed.load(Ordering::SeqCst)
        {
            self.blocked_read_attempts += 1;
            return Poll::Ready(Err(io::Error::other(
                "multipart scheduler read a queued part before it was allowed",
            )));
        }

        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

#[tokio::test]
async fn multipart_scheduler_preserves_final_partial_part_bytes() {
    for (input, expected_parts) in [
        (
            b"abcde".as_slice(),
            vec![(1, b"abcd".as_slice()), (2, b"e".as_slice())],
        ),
        (
            b"abcdefg".as_slice(),
            vec![(1, b"abcd".as_slice()), (2, b"efg".as_slice())],
        ),
        (b"abc".as_slice(), vec![(1, b"abc".as_slice())]),
    ] {
        let (uploaded_tx, mut uploaded_rx) = mpsc::unbounded_channel();
        let upload = move |part_number: i32, chunk: bytes::Bytes| {
            let uploaded_tx = uploaded_tx.clone();
            async move {
                uploaded_tx
                    .send((part_number, chunk))
                    .expect("record uploaded part");
                Ok(CompletedPart::builder()
                    .e_tag(format!("etag-{part_number}"))
                    .part_number(part_number)
                    .build())
            }
        };

        let parts = tokio::time::timeout(
            Duration::from_secs(5),
            upload_parts_streaming_with(Cursor::new(input), 4, 2, upload),
        )
        .await
        .expect("multipart scheduler test timed out")
        .expect("multipart scheduler failed");

        let mut uploaded_parts = Vec::new();
        while let Ok(part) = uploaded_rx.try_recv() {
            uploaded_parts.push(part);
        }
        uploaded_parts.sort_by_key(|(part_number, _)| *part_number);
        let uploaded_bodies = uploaded_parts
            .iter()
            .map(|(part_number, chunk)| (*part_number, chunk.as_ref()))
            .collect::<Vec<_>>();
        assert_eq!(uploaded_bodies, expected_parts, "input: {input:?}");

        let reconstructed = uploaded_parts
            .iter()
            .flat_map(|(_, chunk)| chunk.iter().copied())
            .collect::<Vec<_>>();
        assert_eq!(
            reconstructed, input,
            "uploaded bytes must preserve the input"
        );
        assert_eq!(
            parts
                .iter()
                .map(|part| part.part_number().expect("part_number"))
                .collect::<Vec<_>>(),
            expected_parts
                .iter()
                .map(|(part_number, _)| *part_number)
                .collect::<Vec<_>>()
        );
    }
}

#[tokio::test]
async fn multipart_scheduler_bounds_concurrency_and_returns_parts_ordered() {
    let queued_read_allowed = Arc::new(AtomicBool::new(false));
    let reader = WindowGuardReader {
        inner: Cursor::new(b"aaaabbbbcccc".to_vec()),
        blocked_at: 8,
        queued_read_allowed: Arc::clone(&queued_read_allowed),
        blocked_read_attempts: 0,
    };
    let releases = Arc::new([
        Arc::new(Notify::new()),
        Arc::new(Notify::new()),
        Arc::new(Notify::new()),
    ]);
    let in_flight = Arc::new(AtomicUsize::new(0));
    let peak_in_flight = Arc::new(AtomicUsize::new(0));
    let (started_tx, mut started_rx) = mpsc::unbounded_channel();
    let (completed_tx, mut completed_rx) = mpsc::unbounded_channel();

    let upload = {
        let releases = Arc::clone(&releases);
        let in_flight = Arc::clone(&in_flight);
        let peak_in_flight = Arc::clone(&peak_in_flight);
        move |part_number: i32, chunk: bytes::Bytes| {
            let releases = Arc::clone(&releases);
            let in_flight = Arc::clone(&in_flight);
            let peak_in_flight = Arc::clone(&peak_in_flight);
            let started_tx = started_tx.clone();
            let completed_tx = completed_tx.clone();
            async move {
                let (expected_chunk, release_index): (&[u8], usize) = match part_number {
                    1 => (b"aaaa", 0),
                    2 => (b"bbbb", 1),
                    3 => (b"cccc", 2),
                    _ => panic!("unexpected part_number {part_number}"),
                };
                assert_eq!(chunk.as_ref(), expected_chunk);

                let active = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                peak_in_flight.fetch_max(active, Ordering::SeqCst);
                started_tx.send(part_number).expect("send start event");

                releases[release_index].notified().await;

                let previous_active = in_flight.fetch_sub(1, Ordering::SeqCst);
                assert!(previous_active > 0, "in-flight upload count underflow");
                completed_tx
                    .send(part_number)
                    .expect("send completion event");

                Ok(CompletedPart::builder()
                    .e_tag(format!("etag-{part_number}"))
                    .part_number(part_number)
                    .build())
            }
        }
    };

    let controller = async {
        let mut initial_parts = vec![
            started_rx.recv().await.expect("first upload should start"),
            started_rx.recv().await.expect("second upload should start"),
        ];
        initial_parts.sort_unstable();
        assert_eq!(initial_parts, vec![1, 2]);
        assert_eq!(in_flight.load(Ordering::SeqCst), 2);
        assert_eq!(peak_in_flight.load(Ordering::SeqCst), 2);
        assert!(matches!(
            started_rx.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));

        queued_read_allowed.store(true, Ordering::SeqCst);
        releases[1].notify_one();
        assert_eq!(completed_rx.recv().await, Some(2));
        assert_eq!(started_rx.recv().await, Some(3));
        assert_eq!(in_flight.load(Ordering::SeqCst), 2);
        assert_eq!(peak_in_flight.load(Ordering::SeqCst), 2);

        releases[2].notify_one();
        assert_eq!(completed_rx.recv().await, Some(3));
        releases[0].notify_one();
        assert_eq!(completed_rx.recv().await, Some(1));
        assert_eq!(in_flight.load(Ordering::SeqCst), 0);
        Ok::<(), R2Error>(())
    };
    let scheduler = upload_parts_streaming_with(reader, 4, 2, upload);

    let (parts, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::try_join!(scheduler, controller)
    })
    .await
    .expect("multipart scheduler test timed out")
    .expect("multipart scheduler failed");

    let completed_parts = parts
        .iter()
        .map(|part| {
            (
                part.part_number().expect("part_number"),
                part.e_tag().expect("e_tag").to_string(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        completed_parts,
        vec![
            (1, "etag-1".to_string()),
            (2, "etag-2".to_string()),
            (3, "etag-3".to_string()),
        ]
    );
}

#[tokio::test]
async fn multipart_scheduler_drops_siblings_before_returning_terminal_errors() {
    #[derive(Clone, Copy)]
    enum Failure {
        Upload,
        Join,
        Reader,
    }

    struct DropFlag(Arc<AtomicBool>);

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    for failure in [Failure::Upload, Failure::Join, Failure::Reader] {
        let mut reader = WindowGuardReader {
            inner: Cursor::new(b"aaaabbbbcccc".to_vec()),
            blocked_at: 8,
            queued_read_allowed: Arc::new(AtomicBool::new(false)),
            blocked_read_attempts: 0,
        };
        let initial_uploads_ready = Arc::new(Barrier::new(2));
        let sibling_dropped = Arc::new(AtomicBool::new(false));
        let uploads_started = Arc::new(AtomicUsize::new(0));

        let upload = {
            let initial_uploads_ready = Arc::clone(&initial_uploads_ready);
            let sibling_dropped = Arc::clone(&sibling_dropped);
            let uploads_started = Arc::clone(&uploads_started);
            move |part_number: i32, chunk: bytes::Bytes| {
                let initial_uploads_ready = Arc::clone(&initial_uploads_ready);
                let sibling_dropped = Arc::clone(&sibling_dropped);
                let uploads_started = Arc::clone(&uploads_started);
                async move {
                    uploads_started.fetch_add(1, Ordering::SeqCst);
                    let expected_chunk: &[u8] = match part_number {
                        1 => b"aaaa",
                        2 => b"bbbb",
                        _ => panic!("unexpected part_number {part_number}"),
                    };
                    assert_eq!(chunk.as_ref(), expected_chunk);

                    let _drop_flag =
                        (part_number == 1).then(|| DropFlag(Arc::clone(&sibling_dropped)));
                    initial_uploads_ready.wait().await;

                    if part_number == 1 {
                        std::future::pending::<Result<CompletedPart, R2Error>>().await
                    } else {
                        match failure {
                            Failure::Upload => Err(R2Error::S3("upload part 2 failed".to_string())),
                            Failure::Join => panic!("upload part 2 panicked"),
                            // Free a slot so the reader faults with the sibling still alive.
                            Failure::Reader => Ok(CompletedPart::builder()
                                .e_tag("etag-2")
                                .part_number(part_number)
                                .build()),
                        }
                    }
                }
            }
        };

        let error = tokio::time::timeout(
            Duration::from_secs(5),
            upload_parts_streaming_with(&mut reader, 4, 2, upload),
        )
        .await
        .expect("multipart scheduler test timed out")
        .expect_err("multipart scheduler should return the terminal error");

        assert!(
            sibling_dropped.load(Ordering::SeqCst),
            "sibling upload must be dropped before the scheduler returns"
        );
        assert_eq!(uploads_started.load(Ordering::SeqCst), 2);
        assert_eq!(reader.inner.position(), 8, "queued part must remain unread");
        assert_eq!(
            reader.blocked_read_attempts,
            usize::from(matches!(failure, Failure::Reader)),
            "scheduler must stop reading after the first error"
        );
        match (failure, error) {
            (Failure::Upload, R2Error::S3(message)) => {
                assert_eq!(message, "upload part 2 failed");
            }
            (Failure::Join, R2Error::Io(error)) => {
                assert!(
                    error.to_string().contains("upload part 2 panicked"),
                    "join error must preserve the task panic: {error}"
                );
            }
            (Failure::Reader, R2Error::Io(error)) => {
                assert_eq!(error.kind(), io::ErrorKind::Other);
                assert_eq!(
                    error.to_string(),
                    "multipart scheduler read a queued part before it was allowed"
                );
            }
            (_, other) => panic!("unexpected scheduler error: {other:?}"),
        }
    }
}
