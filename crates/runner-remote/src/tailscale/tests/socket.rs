//! Observe the original native socket without treating a recycled fd as a leak.
use std::{
    os::fd::{AsRawFd, RawFd},
    path::PathBuf,
};

#[derive(Debug)]
pub(super) struct SocketIdentity {
    fd: RawFd,
    identity: PathBuf,
}

impl SocketIdentity {
    pub(super) fn record(socket: &impl AsRawFd) -> Self {
        let fd = socket.as_raw_fd();
        Self {
            fd,
            identity: std::fs::read_link(format!("/proc/self/fd/{fd}"))
                .expect("record native socket identity"),
        }
    }

    fn is_open(&self) -> bool {
        let current = match std::fs::read_link(format!("/proc/self/fd/{}", self.fd)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            result => result.expect("inspect native socket identity"),
        };
        current == self.identity
    }

    pub(super) fn assert_open(&self) {
        assert!(self.is_open(), "original native socket must remain open");
    }

    pub(super) fn assert_closed(&self) {
        assert!(!self.is_open(), "original native socket must be closed");
    }
}

#[test]
fn socket_assertions_follow_identity_through_descriptor_reuse() {
    use std::{
        fs::File,
        io::Read,
        net::{TcpListener, TcpStream},
        os::fd::OwnedFd,
        panic::catch_unwind,
        sync::mpsc,
        time::Duration,
    };

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let socket = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (mut peer, _) = listener.accept().unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let identity = SocketIdentity::record(&socket);
    identity.assert_open();
    assert!(catch_unwind(|| identity.assert_closed()).is_err());

    let socket = OwnedFd::from(socket);
    let replacement = File::open("/dev/null").unwrap();
    std::thread::scope(|scope| {
        let (replaced, observed) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let worker = scope.spawn(move || {
            let fd = socket.as_raw_fd();
            // SAFETY: both descriptors are owned here. Atomically replacing the
            // still-owned target closes the socket without exposing a free slot
            // that another test could allocate before the replacement is installed.
            assert_eq!(
                unsafe { libc::dup3(replacement.as_raw_fd(), fd, libc::O_CLOEXEC) },
                fd
            );
            replaced.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(5)).unwrap();
        });

        observed.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(peer.read(&mut [0]).unwrap(), 0);
        assert_eq!(
            std::fs::read_link(format!("/proc/self/fd/{}", identity.fd)).unwrap(),
            PathBuf::from("/dev/null")
        );
        identity.assert_closed();
        assert!(catch_unwind(|| identity.assert_open()).is_err());
        // Observing old-socket retirement leaves the new descriptor owner intact.
        assert_ne!(unsafe { libc::fcntl(identity.fd, libc::F_GETFD) }, -1);
        release.send(()).unwrap();
        worker.join().unwrap();
    });
    identity.assert_closed();
}
