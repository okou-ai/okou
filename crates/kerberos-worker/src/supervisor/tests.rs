//! Allocation/guard internals, not a substitute for actual native process tests.
#![cfg(test)]
use super::*;

fn allocation() -> (tempfile::TempDir, Arc<Semaphore>, Resources) {
    let target = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("target");
    let root = tempfile::tempdir_in(target).unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let semaphore = Arc::new(Semaphore::new(1));
    let capacity = Capacity {
        permit: Some(semaphore.clone().try_acquire_owned().unwrap()),
        clean: Arc::new(AtomicBool::new(true)),
        reaped: Arc::new(AtomicBool::new(true)),
    };
    let resources = Resources::create(&root.path().canonicalize().unwrap(), capacity).unwrap();
    (root, semaphore, resources)
}

#[test]
fn allocation_drop_before_exec_closes_files_cleans_then_releases() {
    let (root, semaphore, resources) = allocation();
    assert_eq!(semaphore.available_permits(), 0);
    assert_eq!(fs::read_dir(resources.tree.path()).unwrap().count(), 4);
    drop(resources);
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    assert_eq!(semaphore.available_permits(), 1);
}

#[test]
fn actual_os_thread_spawn_failure_cleans_unstarted_resources() {
    let (root, semaphore, resources) = allocation();
    let result = thread::Builder::new()
        .stack_size(usize::MAX / 2)
        .spawn(move || drop(resources));
    assert!(
        result.is_err(),
        "impossible native stack allocation unexpectedly succeeded"
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    assert_eq!(semaphore.available_permits(), 1);
}

#[test]
fn partial_fixed_file_creation_failure_does_not_use_recursive_drop() {
    let (root, semaphore, mut resources) = allocation();
    assert!(matches!(
        resources.tree.create_file("input.cache"),
        Err(Error::Unavailable)
    ));
    drop(resources.cache.take());
    drop(resources.keytab.take());
    drop(resources);
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    assert_eq!(semaphore.available_permits(), 1);
}

#[test]
fn unexpected_entry_is_retained_and_capacity_stays_quarantined() {
    let (_root, semaphore, resources) = allocation();
    let path = resources.tree.path().to_owned();
    fs::write(path.join("unrelated"), b"must not delete").unwrap();
    assert_eq!(resources.cleanup().unwrap_err(), Error::CleanupUnknown);
    assert_eq!(
        fs::read(path.join("unrelated")).unwrap(),
        b"must not delete"
    );
    assert_eq!(fs::read_dir(path).unwrap().count(), 1);
    assert_eq!(semaphore.available_permits(), 0);
}

#[test]
fn recreated_directory_or_dangling_symlink_is_never_deleted_or_treated_absent() {
    for symlink in [false, true] {
        let (_root, semaphore, mut resources) = allocation();
        let path = resources.tree.path().to_owned();
        resources.tree.unlink().unwrap();
        if symlink {
            std::os::unix::fs::symlink("absent-replacement", &path).unwrap();
        } else {
            fs::create_dir(&path).unwrap();
            fs::write(path.join("unrelated"), b"replacement inode").unwrap();
        }
        assert_eq!(resources.cleanup().unwrap_err(), Error::CleanupUnknown);
        assert_eq!(semaphore.available_permits(), 0);
        assert!(fs::symlink_metadata(&path).is_ok());
        if !symlink {
            assert_eq!(
                fs::read(path.join("unrelated")).unwrap(),
                b"replacement inode"
            );
        }
    }
}

#[test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
fn actual_private_pipe_magic_version_reserved_sequence_length_and_state_refuse() {
    let mut good = [0u8; 16];
    good[4..9].copy_from_slice(b"KRB2\x02");
    good[9] = 5;
    good[12..].copy_from_slice(&1u32.to_be_bytes());
    let mut frames = vec![(good, Some((19, Vec::new())))];
    for index in [4, 8, 10, 11, 15] {
        let mut bad = good;
        bad[index] ^= 1;
        frames.push((bad, None));
    }
    let mut stale = good;
    stale[12..].copy_from_slice(&2u32.to_be_bytes());
    frames.push((stale, None));
    let mut oversized = good;
    oversized[..4].copy_from_slice(&(MAX_FRAME as u32 + 1).to_be_bytes());
    frames.push((oversized, None));
    for (kind, error) in [(1, 1), (4, 8), (6, 8), (7, 8), (33, 8)] {
        let mut wrong_state = good;
        wrong_state[9] = kind;
        frames.push((wrong_state, Some((255, vec![error]))));
    }
    for (header, expected) in frames {
        let (root, semaphore, resources) = allocation();
        let mut child = Command::new(resources.tree.path().join("helper"))
            .current_dir(resources.tree.path())
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let reaped = resources.capacity.reaped.clone();
        reaped.store(false, Ordering::Release);
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let id = child.id();
        let mut owner = Reaper {
            child,
            resources: Some(resources),
            reaped,
            failed_cleanup: false,
        };
        fcntl_setfl(&stdin, fcntl_getfl(&stdin).unwrap() | OFlags::NONBLOCK).unwrap();
        fcntl_setfl(&stdout, fcntl_getfl(&stdout).unwrap() | OFlags::NONBLOCK).unwrap();
        let aborted = AtomicBool::new(false);
        let mut io = Io {
            input: &mut stdin,
            output: &mut stdout,
            aborted: &aborted,
            deadline: WallInstant::now() + Duration::from_secs(2),
        };
        let ready = io.reply(0, None).unwrap();
        assert_eq!(ready.kind, 0);
        assert!(ready.payload.is_empty());
        owner.resources.as_mut().unwrap().provision(1, &[]).unwrap();
        let (reply, _waiter) = oneshot::channel();
        let request = Request {
            kind: 5,
            payload: Zeroizing::new(Vec::new()),
            reply,
        };
        io.write(&header, &request).unwrap();
        let result = io.reply(1, Some(&request));
        match expected {
            Some((kind, payload)) => {
                let result = result.unwrap();
                assert_eq!(result.kind, kind);
                assert_eq!(result.payload.as_slice(), payload.as_slice());
            }
            None => assert!(matches!(result, Err(Error::Unavailable))),
        }
        drop(stdin);
        drop(stdout);
        owner.finish().unwrap();
        assert!(!Path::new(&format!("/proc/{id}")).exists());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        assert_eq!(semaphore.available_permits(), 1);
    }
}

#[test]
fn parent_reply_parser_rejects_bad_headers_before_waiting_for_or_allocating_a_body() {
    let mut good = [0u8; 16];
    good[4..9].copy_from_slice(b"KRB2\x02");
    good[9] = 17;
    good[12..].copy_from_slice(&7u32.to_be_bytes());
    let mut frames = vec![(good, true)];
    for index in [4, 8, 10, 11, 15] {
        let mut bad = good;
        bad[index] ^= 1;
        frames.push((bad, false));
    }
    for size in [MAX_FRAME as u32 + 1, u32::MAX] {
        let mut bad = good;
        bad[..4].copy_from_slice(&size.to_be_bytes());
        frames.push((bad, false));
    }
    for (header, valid) in frames {
        // Mock only the external pipe endpoint, never a Kerberos backend/source.
        // No credential, allocation-sized body or native diagnostic is supplied.
        let mut child = Command::new("cat")
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = child.stdout.take().unwrap();
        fcntl_setfl(&output, fcntl_getfl(&output).unwrap() | OFlags::NONBLOCK).unwrap();
        input.write_all(&header).unwrap();
        let aborted = AtomicBool::new(false);
        let mut io = Io {
            input: &mut input,
            output: &mut output,
            aborted: &aborted,
            deadline: WallInstant::now() + Duration::from_secs(2),
        };
        let reply = io.reply(7, None);
        if valid {
            let reply = reply.unwrap();
            assert_eq!(reply.kind, 17);
            assert!(reply.payload.is_empty());
        } else {
            assert!(matches!(reply, Err(Error::Protocol)));
        }
        child.kill().unwrap();
        child.wait().unwrap();
    }
}

#[test]
fn confirmed_file_cleanup_alone_does_not_release_an_unreaped_native_slot() {
    let (root, semaphore, resources) = allocation();
    resources.capacity.reaped.store(false, Ordering::Release);
    resources.cleanup().unwrap();
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    assert_eq!(semaphore.available_permits(), 0);
}
