use super::*;
use std::task::Waker;

#[derive(Clone, Copy)]
enum Outcome {
    Pending,
    Success,
    Error(io::ErrorKind),
}

struct Scripted {
    outcome: Outcome,
    bytes: &'static [u8],
}

impl Scripted {
    fn result(&self) -> Poll<io::Result<()>> {
        match self.outcome {
            Outcome::Pending => Poll::Pending,
            Outcome::Success => Poll::Ready(Ok(())),
            Outcome::Error(kind) => Poll::Ready(Err(io::Error::new(kind, "socket-error-canary"))),
        }
    }
}

impl AsyncRead for Scripted {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let result = self.result();
        if matches!(result, Poll::Ready(Ok(()))) && buf.remaining() >= self.bytes.len() {
            buf.put_slice(self.bytes);
        }
        result
    }
}

impl AsyncWrite for Scripted {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.result().map_ok(|()| bytes.len())
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.result()
    }

    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.result()
    }
}

fn observed(outcome: Outcome) -> Observed<Scripted> {
    Observed {
        socket: Scripted {
            outcome,
            bytes: b"x",
        },
        eof: Arc::new(AtomicBool::new(false)),
        reset: Arc::new(Mutex::new(None)),
    }
}

fn poll(socket: &mut Observed<Scripted>, operation: &str) -> Poll<io::Result<()>> {
    let cx = &mut Context::from_waker(Waker::noop());
    match operation {
        "read" => Pin::new(socket).poll_read(cx, &mut ReadBuf::new(&mut [0])),
        "write" => Pin::new(socket).poll_write(cx, b"x").map_ok(|_| ()),
        "flush" => Pin::new(socket).poll_flush(cx),
        "shutdown" => Pin::new(socket).poll_shutdown(cx),
        _ => panic!("unknown socket operation"),
    }
}

#[test]
fn terminal_io_errors_preserve_the_result_and_record_the_originating_operation() {
    for operation in ["read", "write", "flush", "shutdown"] {
        for kind in [
            io::ErrorKind::ConnectionReset,
            io::ErrorKind::ConnectionAborted,
        ] {
            let mut socket = observed(Outcome::Error(kind));
            let Poll::Ready(Err(error)) = poll(&mut socket, operation) else {
                panic!("terminal error was not preserved");
            };
            assert_eq!(error.kind(), kind);
            assert_eq!(error.to_string(), "socket-error-canary");
            assert_eq!(
                *socket.reset.lock().unwrap(),
                Some(Reset { operation, kind })
            );
            assert!(!socket.eof.load(Ordering::Acquire));
        }
    }
}

#[test]
fn ordinary_io_errors_pending_and_success_do_not_establish_peer_closure() {
    for operation in ["read", "write", "flush", "shutdown"] {
        for outcome in [
            Outcome::Pending,
            Outcome::Success,
            Outcome::Error(io::ErrorKind::WouldBlock),
            Outcome::Error(io::ErrorKind::Interrupted),
            Outcome::Error(io::ErrorKind::TimedOut),
            Outcome::Error(io::ErrorKind::InvalidData),
            Outcome::Error(io::ErrorKind::Other),
            Outcome::Error(io::ErrorKind::BrokenPipe),
            Outcome::Error(io::ErrorKind::NotConnected),
        ] {
            let mut socket = observed(outcome);
            let result = poll(&mut socket, operation);
            match outcome {
                Outcome::Pending => assert!(result.is_pending()),
                Outcome::Success => assert!(matches!(result, Poll::Ready(Ok(())))),
                Outcome::Error(kind) => {
                    assert!(matches!(result, Poll::Ready(Err(error)) if error.kind() == kind));
                }
            }
            assert_eq!(*socket.reset.lock().unwrap(), None, "{operation}");
            assert!(!socket.eof.load(Ordering::Acquire), "{operation}");
        }
    }
}

#[test]
fn only_a_nonempty_read_request_can_observe_eof() {
    let mut socket = observed(Outcome::Success);
    socket.socket.bytes = b"";
    let cx = &mut Context::from_waker(Waker::noop());
    assert!(matches!(
        Pin::new(&mut socket).poll_read(cx, &mut ReadBuf::new(&mut [])),
        Poll::Ready(Ok(()))
    ));
    assert!(!socket.eof.load(Ordering::Acquire));
    assert!(matches!(poll(&mut socket, "read"), Poll::Ready(Ok(()))));
    assert!(socket.eof.load(Ordering::Acquire));
    assert_eq!(*socket.reset.lock().unwrap(), None);
}

#[tokio::test]
async fn a_real_peer_reset_is_observed_on_write_without_reading_the_socket() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let peer = tokio::net::TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (socket, _) = listener.accept().await.unwrap();
    peer.set_zero_linger().unwrap();
    drop(peer);
    // Wait for error readiness without consuming the socket error in a read
    // callback, so the write is the first operation to observe it.
    assert!(
        bounded(socket.ready(tokio::io::Interest::ERROR))
            .await
            .unwrap()
            .is_error()
    );
    let mut socket = Observed {
        socket,
        eof: Arc::new(AtomicBool::new(false)),
        reset: Arc::new(Mutex::new(None)),
    };
    let error = bounded(socket.write_all(b"closed peer")).await.unwrap_err();
    assert!(matches!(
        error.kind(),
        io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted
    ));
    assert_eq!(
        *socket.reset.lock().unwrap(),
        Some(Reset {
            operation: "write",
            kind: error.kind(),
        })
    );
    assert!(!socket.eof.load(Ordering::Acquire));
}

#[tokio::test]
async fn a_locally_half_closed_socket_does_not_establish_peer_closure() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut peer = tokio::net::TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (socket, _) = listener.accept().await.unwrap();
    let mut socket = Observed {
        socket,
        eof: Arc::new(AtomicBool::new(false)),
        reset: Arc::new(Mutex::new(None)),
    };
    bounded(socket.shutdown()).await.unwrap();
    let error = bounded(socket.write_all(b"local shutdown"))
        .await
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
    assert_eq!(*socket.reset.lock().unwrap(), None);
    assert!(!socket.eof.load(Ordering::Acquire));
    bounded(peer.write_all(b"open")).await.unwrap();
    let mut bytes = [0; 4];
    bounded(socket.read_exact(&mut bytes)).await.unwrap();
    assert_eq!(&bytes, b"open");
    assert!(!socket.eof.load(Ordering::Acquire));
    bounded(peer.shutdown()).await.unwrap();
    assert_eq!(bounded(socket.read(&mut [0])).await.unwrap(), 0);
    assert!(socket.eof.load(Ordering::Acquire));
}
