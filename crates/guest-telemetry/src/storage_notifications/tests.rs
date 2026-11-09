use super::*;
use std::io::Write;
use std::os::unix::net::UnixStream;

#[test]
fn descriptor_bootstrap_preserves_payload_and_reuses_a_clean_notification_group() {
    let directory = tempfile::tempdir().unwrap();
    let owner = NotificationOwner::default();
    let mut previous_watch = None;
    for operation in 0..3 {
        let lease = owner.lease().unwrap();
        let (mut sender, mut receiver) = UnixStream::pair().unwrap();
        send(&sender, lease.descriptor()).unwrap();
        sender.write_all(b"exact manifest payload").unwrap();
        let received = receive(&receiver).unwrap();
        assert!(
            rustix::io::fcntl_getfd(&received)
                .unwrap()
                .contains(rustix::io::FdFlags::CLOEXEC)
        );
        let mut payload = [0_u8; 22];
        receiver.read_exact(&mut payload).unwrap();
        assert_eq!(&payload, b"exact manifest payload");
        let mut events = File::from(received);
        let mut buffer = [0_u8; 4096];
        assert_eq!(
            events.read(&mut buffer).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        let watch =
            inotify::add_watch(&events, directory.path(), inotify::WatchFlags::CREATE).unwrap();
        if let Some(previous) = previous_watch {
            assert!(watch > previous);
        }
        previous_watch = Some(watch);
        std::fs::write(directory.path().join(format!("{operation}.ready")), []).unwrap();
        assert!(events.read(&mut buffer).unwrap() > 0);
        // Model an exited helper that left its watch behind. The parent must
        // remove it and drain IN_IGNORED before lending the same group again.
        drop(events);
        lease.finish().unwrap();
    }
}

fn references(path: &std::path::Path) -> usize {
    std::fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| std::fs::read_link(entry.path()).is_ok_and(|target| target == path))
        .count()
}

#[test]
fn invalid_and_truncated_bootstraps_close_all_received_capabilities() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("capability");
    let file = File::create(&path).unwrap();
    for (version, count) in [(1, 1), (2, 1), (1, 2), (1, 8)] {
        let before = references(&path);
        let (sender, receiver) = UnixStream::pair().unwrap();
        let descriptors = vec![file.as_fd(); count];
        let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(8))];
        let mut control = SendAncillaryBuffer::new(&mut space);
        assert!(control.push(SendAncillaryMessage::ScmRights(&descriptors)));
        assert_eq!(
            sendmsg(
                &sender,
                &[IoSlice::new(&[version])],
                &mut control,
                SendFlags::NOSIGNAL
            )
            .unwrap(),
            1
        );
        assert_eq!(
            receive(&receiver).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            references(&path),
            before,
            "version={version}, count={count}"
        );
    }
    let (mut sender, receiver) = UnixStream::pair().unwrap();
    sender.write_all(&[1]).unwrap();
    assert_eq!(
        receive(receiver).unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
}

#[test]
fn unsettled_or_unconfirmable_notification_state_cannot_be_reused() {
    let owner = NotificationOwner::default();
    drop(owner.lease().unwrap());
    assert!(owner.lease().is_err());

    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("first");
    let second = directory.path().join("second");
    std::fs::create_dir(&first).unwrap();
    std::fs::create_dir(&second).unwrap();
    let owner = NotificationOwner::default();
    let lease = owner.lease().unwrap();
    inotify::add_watch(lease.descriptor(), &first, inotify::WatchFlags::CREATE).unwrap();
    inotify::add_watch(lease.descriptor(), &second, inotify::WatchFlags::CREATE).unwrap();
    assert!(lease.finish().is_err());
    assert!(owner.lease().is_err());
}
