use super::*;
use std::io::Read;
use std::sync::atomic::AtomicUsize;

fn set_send_buffer(stream: &UnixStream, size: libc::c_int) -> io::Result<()> {
    // SAFETY: setsockopt receives a valid socket fd and a pointer to a
    // properly sized integer option value for the duration of the call.
    let ret = unsafe {
        libc::setsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_SNDBUF,
            (&size as *const libc::c_int).cast(),
            std::mem::size_of_val(&size) as libc::socklen_t,
        )
    };
    if ret < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[test]
fn write_frame_sends_complete_frame() {
    let (guest, mut peer) = UnixStream::pair().unwrap();
    set_send_buffer(&guest, 4096).unwrap();
    let writer = GuestWriter::new(guest);
    let frame = vec![7u8; 1024 * 1024];
    let expected = frame.clone();

    let reader = std::thread::spawn(move || {
        let mut received = Vec::new();
        peer.read_to_end(&mut received).unwrap();
        received
    });

    writer
        .write_frame_with_deadline(&frame, Duration::from_secs(5))
        .unwrap();
    drop(writer);

    assert_eq!(reader.join().unwrap(), expected);
}

#[test]
fn write_frame_after_lock_runs_hook_before_frame_and_blocks_other_writers() {
    let (guest, mut peer) = UnixStream::pair().unwrap();
    let writer = GuestWriter::new(guest);
    let writer_a = writer.clone();
    let writer_b = writer.clone();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (second_ready_tx, second_ready_rx) = std::sync::mpsc::channel();

    let first = std::thread::spawn(move || {
        writer_a
            .write_frame_after_lock(b"first", || {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            })
            .unwrap();
    });
    entered_rx.recv().unwrap();

    let second = std::thread::spawn(move || {
        second_ready_tx.send(()).unwrap();
        writer_b.write_frame(b"second").unwrap();
    });

    second_ready_rx.recv().unwrap();
    release_tx.send(()).unwrap();
    first.join().unwrap();
    second.join().unwrap();
    drop(writer);

    let mut received = Vec::new();
    peer.read_to_end(&mut received).unwrap();
    assert_eq!(received, b"firstsecond");
}

#[test]
fn write_frame_after_lock_unless_cancelled_suppresses_queued_frame() {
    let (guest, mut peer) = UnixStream::pair().unwrap();
    let writer = GuestWriter::new(guest);
    let blocker_writer = writer.clone();
    let pending_writer = writer.clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    let pending_cancelled = Arc::clone(&cancelled);
    let release_count = Arc::new(AtomicUsize::new(0));
    let pending_release_count = Arc::clone(&release_count);
    let (locked_tx, locked_rx) = std::sync::mpsc::channel();
    let (unlock_tx, unlock_rx) = std::sync::mpsc::channel();
    let (pending_tx, pending_rx) = std::sync::mpsc::channel();

    let blocker = std::thread::spawn(move || {
        blocker_writer
            .write_frame_after_lock(b"", || {
                locked_tx.send(()).unwrap();
                unlock_rx.recv().unwrap();
            })
            .unwrap();
    });
    locked_rx.recv().unwrap();

    let pending = std::thread::spawn(move || {
        pending_tx.send(()).unwrap();
        pending_writer.write_frame_after_lock_unless_cancelled(
            b"cancelled",
            &pending_cancelled,
            || {
                pending_release_count.fetch_add(1, Ordering::Relaxed);
            },
        )
    });
    pending_rx.recv().unwrap();

    cancelled.store(true, Ordering::Release);
    unlock_tx.send(()).unwrap();
    blocker.join().unwrap();

    assert!(!pending.join().unwrap().unwrap());
    assert_eq!(release_count.load(Ordering::Relaxed), 1);
    drop(writer);

    let mut received = Vec::new();
    peer.read_to_end(&mut received).unwrap();
    assert!(received.is_empty());
}

#[test]
fn write_frame_after_lock_unless_cancelled_sends_live_frame() {
    let (guest, mut peer) = UnixStream::pair().unwrap();
    let writer = GuestWriter::new(guest);
    let cancelled = AtomicBool::new(false);
    let release_count = AtomicUsize::new(0);

    let sent = writer
        .write_frame_after_lock_unless_cancelled(b"live", &cancelled, || {
            release_count.fetch_add(1, Ordering::Relaxed);
        })
        .unwrap();

    assert!(sent);
    assert_eq!(release_count.load(Ordering::Relaxed), 1);
    drop(writer);

    let mut received = Vec::new();
    peer.read_to_end(&mut received).unwrap();
    assert_eq!(received, b"live");
}

#[test]
fn write_frame_fails_when_peer_is_closed() {
    let (guest, peer) = UnixStream::pair().unwrap();
    peer.shutdown(Shutdown::Read).unwrap();
    let writer = GuestWriter::new(guest);

    let err = writer
        .write_frame_with_deadline(&[1, 2, 3, 4], Duration::from_secs(1))
        .unwrap_err();

    assert!(matches!(
        err.kind(),
        io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
    ));
}

#[test]
fn write_frame_times_out_when_peer_stops_reading() {
    let (guest, mut peer) = UnixStream::pair().unwrap();
    set_send_buffer(&guest, 4096).unwrap();
    let writer = GuestWriter::new(guest);
    let frame = vec![0xAB; 8 * 1024 * 1024];

    let started = Instant::now();
    let err = writer
        .write_frame_with_deadline(&frame, Duration::from_millis(100))
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(5));

    peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    let mut drained = Vec::new();
    peer.read_to_end(&mut drained).unwrap();
}
