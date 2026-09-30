//! Inert private echo consumer for the run-scoped Guest duplex transport.
//! No exec, file, chat, SSH or VNC method is interpreted here.

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use guest_contracts::private_duplex::{
    ACTIVATE, MAX_FRAME_BYTES, MAX_STREAMS_PER_RUN, READY, VSOCK_PORT,
};
const RETRY: Duration = Duration::from_millis(100);
// Bound a stalled ingress acknowledgement so the only pending Guest worker
// can close this attempt and retry. Runner and Guest ship as one artifact.
const INGRESS_ACK_TIMEOUT: Duration = Duration::from_secs(5);

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
                if await_activation(&mut stream, INGRESS_ACK_TIMEOUT).is_err() {
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

fn await_activation(stream: &mut UnixStream, ack_timeout: Duration) -> io::Result<()> {
    stream.set_read_timeout(Some(ack_timeout))?;
    let mut marker = [0];
    stream.read_exact(&mut marker)?;
    if marker != [READY] {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "duplex ingress not acknowledged",
        ));
    }
    // READY is not authority. The acknowledged idle connection waits for
    // exact-run activation without churning through the single pending slot.
    stream.set_read_timeout(None)?;
    stream.read_exact(&mut marker)?;
    if marker != [ACTIVATE] {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "duplex not activated",
        ));
    }
    Ok(())
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
    fn dedicated_ingress_acknowledges_before_assignment_activation() {
        let (mut guest, mut host) = UnixStream::pair().unwrap();
        let worker = std::thread::spawn(move || {
            await_activation(&mut guest, Duration::from_millis(100)).unwrap();
            guest
        });
        host.write_all(&[READY]).unwrap();
        host.write_all(&[ACTIVATE]).unwrap();
        let _activated = worker.join().unwrap();
    }

    #[test]
    fn missing_ingress_ack_times_out_without_activation() {
        let (mut guest, _unresponsive_host) = UnixStream::pair().unwrap();
        let worker =
            std::thread::spawn(move || await_activation(&mut guest, Duration::from_millis(20)));
        assert!(matches!(
            worker.join().unwrap().unwrap_err().kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
        ));
    }

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
    fn truncated_frames_are_rejected_without_echoing_partial_data() {
        for truncated in [b"\0\0".as_slice(), b"\0\0\0\x03xy".as_slice()] {
            let (mut host, guest) = UnixStream::pair().unwrap();
            host.write_all(truncated).unwrap();
            host.shutdown(std::net::Shutdown::Write).unwrap();
            assert_eq!(
                serve_echo(guest).unwrap_err().kind(),
                io::ErrorKind::UnexpectedEof
            );
            assert_eq!(host.read(&mut [0]).unwrap(), 0);
        }
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
