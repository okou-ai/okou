//! Inert private echo consumer for the run-scoped Guest duplex transport.
//! No exec, file, chat, SSH or VNC method is interpreted here.

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use guest_contracts::private_duplex::{ACTIVATE, MAX_FRAME_BYTES, MAX_STREAMS_PER_RUN, VSOCK_PORT};
const RETRY: Duration = Duration::from_millis(100);

struct WorkerCount(Arc<AtomicUsize>);
impl Drop for WorkerCount {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Run separately from the guest control loop. Only one idle connection waits
/// for host activation; no per-sandbox pool of speculative guest workers.
pub(crate) fn run() {
    let active = Arc::new(AtomicUsize::new(0));
    loop {
        if active.load(Ordering::Acquire) >= MAX_STREAMS_PER_RUN {
            std::thread::sleep(RETRY);
            continue;
        }
        match super::connection::connect_vsock_port(VSOCK_PORT) {
            Ok(mut stream) => {
                let mut activation = [0u8; 1];
                if stream.read_exact(&mut activation).is_err() || activation[0] != ACTIVATE {
                    std::thread::sleep(RETRY);
                    continue;
                }
                active.fetch_add(1, Ordering::AcqRel);
                let count = WorkerCount(Arc::clone(&active));
                if std::thread::Builder::new()
                    .name("guest-duplex".into())
                    .spawn(move || {
                        let _count = count;
                        let _ = serve_echo(stream);
                    })
                    .is_err()
                {
                    // The closure (and guard) are dropped on spawn failure.
                    std::thread::sleep(RETRY);
                }
            }
            Err(_) => std::thread::sleep(RETRY),
        }
    }
}

/// Finite frame buffer and per-direction ordered, backpressured echo. EOF of
/// the inbound direction sends EOF outward; malformed/oversized frames reset.
pub(crate) fn serve_echo(mut stream: UnixStream) -> io::Result<()> {
    let mut data = vec![0u8; MAX_FRAME_BYTES];
    loop {
        let mut header = [0u8; 4];
        if stream.read(&mut header[..1])? == 0 {
            return stream.shutdown(std::net::Shutdown::Write);
        }
        stream.read_exact(&mut header[1..])?;
        let size = u32::from_be_bytes(header) as usize;
        if size > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "guest frame too large",
            ));
        }
        let payload = data
            .get_mut(..size)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "guest frame too large"))?;
        stream.read_exact(payload)?;
        stream.write_all(&header)?;
        stream.write_all(payload)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn echo_preserves_order_and_half_close() {
        let (mut host, guest) = UnixStream::pair().unwrap();
        let worker = std::thread::spawn(move || serve_echo(guest));
        for frame in [b"first".as_slice(), b"second".as_slice()] {
            host.write_all(&(frame.len() as u32).to_be_bytes()).unwrap();
            host.write_all(frame).unwrap();
        }
        host.shutdown(std::net::Shutdown::Write).unwrap();
        for frame in [b"first".as_slice(), b"second".as_slice()] {
            let mut header = [0u8; 4];
            host.read_exact(&mut header).unwrap();
            let mut bytes = vec![0u8; u32::from_be_bytes(header) as usize];
            host.read_exact(&mut bytes).unwrap();
            assert_eq!(bytes, frame);
        }
        let mut end = [0u8];
        assert_eq!(host.read(&mut end).unwrap(), 0);
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn oversized_frame_is_rejected() {
        let (mut host, guest) = UnixStream::pair().unwrap();
        host.write_all(&((MAX_FRAME_BYTES + 1) as u32).to_be_bytes())
            .unwrap();
        assert_eq!(
            serve_echo(guest).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
