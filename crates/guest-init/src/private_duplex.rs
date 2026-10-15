//! Guest-side worker for the independent, private run-scoped duplex transport.
//! Started by guest-init in its existing PID 2 child; no separate daemon.
//! Service handlers live in guest-channel-server; this owner grants no authority.

use std::io::{self, Read};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use guest_contracts::private_duplex::{ACTIVATE, MAX_STREAMS_PER_RUN, READY, VSOCK_PORT};
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
pub(super) fn run() {
    // PID2 has already forked. One worker serves all activated connection epochs.
    let filesystem = loop {
        match guest_channel_server::Filesystem::new() {
            Ok(filesystem) => break filesystem,
            // Match the acceptor's owned resource-recovery loop. A temporary
            // thread shortage must not permanently remove the application port.
            Err(_) => std::thread::sleep(RETRY),
        }
    };
    let active = Arc::new(AtomicUsize::new(0));
    loop {
        if active.load(Ordering::Acquire) >= MAX_STREAMS_PER_RUN {
            std::thread::sleep(RETRY);
            continue;
        }
        match connect_vsock() {
            Ok(mut stream) => {
                if await_activation(&mut stream, INGRESS_ACK_TIMEOUT).is_err() {
                    std::thread::sleep(RETRY);
                    continue;
                }
                let filesystem = filesystem.clone();
                if start_worker(stream, &active, |stream, count| {
                    std::thread::Builder::new()
                        .name("gdup-channel".into())
                        .spawn(move || {
                            let _count = count;
                            let _ = guest_channel_server::run_with_filesystem(stream, &filesystem);
                        })
                })
                .is_err()
                {
                    std::thread::sleep(RETRY);
                }
            }
            Err(_) => std::thread::sleep(RETRY),
        }
    }
}

/// Count before spawning; the moved guard and socket are dropped on spawn failure.
/// Only the successfully started worker may acknowledge readiness.
fn start_worker(
    stream: UnixStream,
    active: &Arc<AtomicUsize>,
    spawn: impl FnOnce(UnixStream, WorkerCount) -> io::Result<std::thread::JoinHandle<()>>,
) -> io::Result<std::thread::JoinHandle<()>> {
    active.fetch_add(1, Ordering::AcqRel);
    spawn(stream, WorkerCount(Arc::clone(active)))
}

/// Connect only to the dedicated private host listener. Do not use the control
/// service's connector: this worker owns its own port and lifecycle.
#[cfg(target_os = "linux")]
fn connect_vsock() -> io::Result<UnixStream> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    // SAFETY: valid socket constants; ownership is adopted only on success.
    let raw = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: this socket has exactly one owner, including on connect failure.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let address = libc::sockaddr_vm {
        svm_family: libc::AF_VSOCK as u16,
        svm_reserved1: 0,
        svm_port: VSOCK_PORT,
        svm_cid: libc::VMADDR_CID_HOST,
        svm_zero: [0; 4],
    };
    // SAFETY: fd is owned and address is initialized and live for this call.
    let result = unsafe {
        libc::connect(
            fd.as_raw_fd(),
            std::ptr::from_ref(&address).cast(),
            std::mem::size_of_val(&address) as libc::socklen_t,
        )
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    // AF_VSOCK stream descriptors support read/write/shutdown without AF_UNIX addresses.
    Ok(UnixStream::from(fd))
}

#[cfg(not(target_os = "linux"))]
fn connect_vsock() -> io::Result<UnixStream> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "duplex transport requires Linux vsock",
    ))
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

#[cfg(test)]
mod tests {
    use super::*;
    use guest_contracts::{
        private_duplex::{ACTIVATED, MAX_FRAME_BYTES},
        sandbox_channel::{Message, decode_message},
    };
    use std::io::Write;

    fn send(host: &mut UnixStream, frame: &str) {
        host.write_all(&(frame.len() as u32).to_be_bytes()).unwrap();
        host.write_all(frame.as_bytes()).unwrap();
    }
    fn receive(host: &mut UnixStream) -> Message {
        let mut header = [0; 4];
        host.read_exact(&mut header).unwrap();
        let mut frame = vec![0; u32::from_be_bytes(header) as usize];
        host.read_exact(&mut frame).unwrap();
        decode_message(&frame).unwrap()
    }
    fn hello(host: &mut UnixStream) {
        send(
            host,
            r#"{"schemaVersion":1,"type":"hello","id":"00000000-0000-4000-8000-000000000001","categories":{"diagnostics":1}}"#,
        );
        match receive(host) {
            Message::Response {
                request_id,
                result: Some(result),
                error: None,
                ..
            } => {
                assert_eq!(request_id, "00000000-0000-4000-8000-000000000001");
                assert_eq!(
                    result
                        .get("categories")
                        .unwrap()
                        .get("diagnostics")
                        .unwrap()
                        .as_u64(),
                    Some(1)
                );
                assert!(result.get("categories").unwrap().get("fs").is_none());
            }
            other => panic!("invalid hello result: {other:?}"),
        }
        assert!(matches!(receive(host), Message::Event { event, .. } if event == "notice"));
    }

    #[test]
    fn dedicated_ingress_acknowledges_before_assignment_activation() {
        let (mut guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&active);
        let worker = std::thread::spawn(move || {
            await_activation(&mut guest, Duration::from_millis(100)).unwrap();
            start_worker(guest, &count, |stream, count| {
                Ok(std::thread::spawn(move || {
                    let _count = count;
                    guest_channel_server::run(stream).unwrap();
                }))
            })
            .unwrap()
            .join()
            .unwrap();
        });
        host.write_all(&[READY, ACTIVATE]).unwrap();
        let mut ready = [0];
        host.read_exact(&mut ready).unwrap();
        assert_eq!(ready, [ACTIVATED]);
        hello(&mut host);
        host.shutdown(std::net::Shutdown::Write).unwrap();
        assert_eq!(host.read(&mut [0]).unwrap(), 0);
        worker.join().unwrap();
        assert_eq!(active.load(Ordering::Acquire), 0);
    }

    #[test]
    fn worker_spawn_failure_closes_without_ready_and_releases_capacity() {
        let (mut guest, mut host) = UnixStream::pair().unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        host.write_all(&[READY, ACTIVATE]).unwrap();
        await_activation(&mut guest, Duration::from_millis(100)).unwrap();
        let error = start_worker(guest, &active, |_stream, _count| {
            Err(io::Error::other("injected worker spawn failure"))
        })
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(host.read(&mut [0]).unwrap(), 0);
        assert_eq!(active.load(Ordering::Acquire), 0);
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
    fn diagnostics_preserve_correlations_and_half_close() {
        let (mut host, guest) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let worker = std::thread::spawn(move || guest_channel_server::run(guest));
        let mut ready = [0];
        host.read_exact(&mut ready).unwrap();
        assert_eq!(ready, [ACTIVATED]);
        hello(&mut host);
        for (index, payload) in [(2, "Zmlyc3Q="), (3, "c2Vjb25k")] {
            send(
                &mut host,
                &format!(
                    r#"{{"schemaVersion":1,"type":"request","id":"00000000-0000-4000-8000-{index:012x}","category":"diagnostics","categoryVersion":1,"operation":"echo","params":{{"payload":"{payload}"}}}}"#
                ),
            );
        }
        let mut seen = std::collections::BTreeSet::new();
        for _ in 0..2 {
            match receive(&mut host) {
                Message::Response {
                    request_id,
                    result: Some(result),
                    error: None,
                    ..
                } => {
                    let expected = match request_id.as_str() {
                        "00000000-0000-4000-8000-000000000002" => "Zmlyc3Q=",
                        "00000000-0000-4000-8000-000000000003" => "c2Vjb25k",
                        _ => panic!("unowned response"),
                    };
                    assert_eq!(result.get("payload").unwrap().as_str(), Some(expected));
                    assert!(seen.insert(request_id));
                }
                other => panic!("invalid echo result: {other:?}"),
            }
        }
        host.shutdown(std::net::Shutdown::Write).unwrap();
        assert_eq!(host.read(&mut [0]).unwrap(), 0);
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn truncated_frames_are_rejected_without_partial_output() {
        for truncated in [b"\0\0".as_slice(), b"\0\0\0\x03xy".as_slice()] {
            let (mut host, guest) = UnixStream::pair().unwrap();
            host.write_all(truncated).unwrap();
            host.shutdown(std::net::Shutdown::Write).unwrap();
            assert_eq!(
                guest_channel_server::run(guest).unwrap_err().kind(),
                io::ErrorKind::UnexpectedEof
            );
            let mut ready = [0];
            host.read_exact(&mut ready).unwrap();
            assert_eq!(ready, [ACTIVATED]);
            assert_eq!(host.read(&mut [0]).unwrap(), 0);
        }
    }

    #[test]
    fn oversized_frame_is_rejected_before_payload_allocation() {
        let (mut host, guest) = UnixStream::pair().unwrap();
        host.write_all(&((MAX_FRAME_BYTES + 1) as u32).to_be_bytes())
            .unwrap();
        assert_eq!(
            guest_channel_server::run(guest).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
