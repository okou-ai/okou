use super::*;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

const WAIT_TIMEOUT: Duration = Duration::from_secs(5);

struct ControlledBodyReader {
    read_entered: Option<Sender<()>>,
    body: Receiver<Option<u8>>,
    inner_duration: Rc<Cell<Duration>>,
}

impl Read for ControlledBodyReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let start = Instant::now();
        if let Some(read_entered) = &self.read_entered {
            read_entered.send(()).map_err(io::Error::other)?;
        }
        let byte = self
            .body
            .recv_timeout(WAIT_TIMEOUT)
            .map_err(io::Error::other)?;
        let bytes_read = if let Some(byte) = byte {
            buffer[0] = byte;
            1
        } else {
            0
        };
        self.inner_duration.set(start.elapsed());
        Ok(bytes_read)
    }
}

fn assert_body_read_attribution(body_ready_before_read: bool) {
    // The binary exposes no read-entry signal. Control the underlying Read
    // here so its timing can be checked without assumptions about scheduling.
    thread::scope(|scope| {
        let (read_entered_tx, read_entered_rx) = mpsc::channel();
        let (body_tx, body_rx) = mpsc::channel();
        let inner_duration = Rc::new(Cell::new(Duration::ZERO));
        let metrics = RemoteArchiveAttemptMetrics::default();
        let header_duration = Duration::from_millis(123);
        metrics.record_request_to_response_headers(header_duration);
        let source = ArchiveSource::http(
            ControlledBodyReader {
                read_entered: (!body_ready_before_read).then_some(read_entered_tx),
                body: body_rx,
                inner_duration: inner_duration.clone(),
            },
            metrics.clone(),
        );
        let (mut reader, failure) = source.into_parts();
        let producer = scope.spawn(move || {
            for byte in [Some(b'a'), Some(b'b'), None] {
                if !body_ready_before_read {
                    read_entered_rx.recv_timeout(WAIT_TIMEOUT).unwrap();
                }
                body_tx.send(byte).unwrap();
            }
        });
        if body_ready_before_read {
            // Deliberately hold the client until the entire body and EOF are
            // available, reproducing the ordering that broke the binary test.
            producer.join().unwrap();
        }
        assert_eq!(metrics.snapshot().body_read, Duration::ZERO);

        let mut consumed = 0;
        for expected in [Some(b'a'), Some(b'b'), None] {
            let before = metrics.snapshot();
            let mut buffer = [0];
            let start = Instant::now();
            let bytes_read = reader.read(&mut buffer).unwrap();
            let outer_duration = start.elapsed();
            let after = metrics.snapshot();
            let measured = after.body_read.checked_sub(before.body_read).unwrap();

            // These intervals are nested even if any participating thread is
            // descheduled. No particular number of milliseconds is required.
            assert!(measured >= inner_duration.get());
            assert!(measured <= outer_duration);
            assert_eq!(after.request_to_response_headers, header_duration);
            assert_eq!(bytes_read, usize::from(expected.is_some()));
            if let Some(byte) = expected {
                assert_eq!(buffer[0], byte);
                consumed += 1;
            }
            assert_eq!(after.compressed_bytes_consumed, consumed);
            assert!(!failure.failed());
        }
    });
}

#[test]
fn body_read_timing_includes_wait_after_read_entry() {
    assert_body_read_attribution(false);
}

#[test]
fn body_read_timing_accepts_body_ready_before_read() {
    assert_body_read_attribution(true);
}
