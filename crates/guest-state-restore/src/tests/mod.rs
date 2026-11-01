use super::*;
use std::cell::Cell;
use std::cell::RefCell;
use std::fs;
use std::os::unix::fs::MetadataExt;

#[test]
fn read_entropy_accepts_raw_stdin_bytes() {
    let entropy = read_entropy(&b"\0host-entropy"[..]).unwrap();
    assert_eq!(entropy, b"\0host-entropy");
}

#[test]
fn read_entropy_rejects_empty_stdin() {
    let err = read_entropy(&b""[..]).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(err.to_string(), "empty entropy");
}

#[test]
fn read_entropy_rejects_oversized_stdin() {
    let entropy = vec![0; MAX_ENTROPY_BYTES + 1];
    let err = read_entropy(&entropy[..]).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(err.to_string(), "entropy too large");
}

#[test]
fn read_entropy_accepts_max_size_stdin() {
    let input = vec![7; MAX_ENTROPY_BYTES];
    let entropy = read_entropy(&input[..]).unwrap();
    assert_eq!(entropy, input);
}

#[test]
fn run_with_reseed_passes_raw_entropy_to_reseed() {
    let mut stderr = Vec::new();
    let mut seen = Vec::new();
    let code = run_with_reseed(
        &b"\0secret"[..],
        &mut stderr,
        std::iter::empty::<&str>(),
        |entropy| {
            seen.extend_from_slice(entropy);
            Ok(())
        },
    );

    assert_eq!(code, 0);
    assert_eq!(seen, b"\0secret");
    assert!(stderr.is_empty());
}

#[test]
fn run_with_reseed_rejects_empty_entropy_without_calling_reseed() {
    let called = Cell::new(false);
    let mut stderr = Vec::new();
    let code = run_with_reseed(&b""[..], &mut stderr, std::iter::empty::<&str>(), |_| {
        called.set(true);
        Ok(())
    });

    assert_eq!(code, 1);
    assert!(!called.get());
    assert_eq!(
        String::from_utf8(stderr).unwrap(),
        "guest-state-restore: empty entropy\n"
    );
}

#[test]
fn run_with_reseed_reports_reseed_failure() {
    let mut stderr = Vec::new();
    let code = run_with_reseed(
        &b"entropy"[..],
        &mut stderr,
        std::iter::empty::<&str>(),
        |_| Err(io::Error::other("ioctl denied")),
    );

    assert_eq!(code, 1);
    assert_eq!(
        String::from_utf8(stderr).unwrap(),
        "guest-state-restore: ioctl denied\n"
    );
}

#[test]
fn run_with_reseed_rejects_argv_entropy_without_calling_reseed() {
    let called = Cell::new(false);
    let mut stderr = Vec::new();
    let code = run_with_reseed(&b"entropy"[..], &mut stderr, ["old-hex-argv"], |_| {
        called.set(true);
        Ok(())
    });

    assert_eq!(code, 1);
    assert!(!called.get());
    assert_eq!(
        String::from_utf8(stderr).unwrap(),
        "usage: guest-state-restore < entropy-bytes\n"
    );
}

#[test]
fn timezone_mode_only_applies_timezone() {
    let clock_called = Cell::new(false);
    let reseed_called = Cell::new(false);
    let timezone = RefCell::new(None);
    let mut stderr = Vec::new();

    let code = run_with_operations(
        &b""[..],
        &mut stderr,
        [TIMEZONE_MODE_ARG, "Asia/Shanghai"],
        |_, _| {
            clock_called.set(true);
            Ok(())
        },
        |_| {
            reseed_called.set(true);
            Ok(())
        },
        |received| {
            timezone.replace(Some(received.to_owned()));
            Ok(true)
        },
    );

    assert_eq!(code, 0);
    assert!(!clock_called.get());
    assert!(!reseed_called.get());
    assert_eq!(timezone.into_inner().as_deref(), Some("Asia/Shanghai"));
    assert!(stderr.is_empty());
}

#[test]
fn timezone_mode_reports_best_effort_outcomes() {
    for (timezone_result, marker) in [
        (Ok(false), TIMEZONE_UNAVAILABLE_MARKER),
        (
            Err(io::Error::other("write denied")),
            TIMEZONE_SYNC_FAILED_MARKER,
        ),
    ] {
        let mut stderr = Vec::new();
        let code = run_with_operations(
            &b""[..],
            &mut stderr,
            [TIMEZONE_MODE_ARG, "UTC"],
            |_, _| Ok(()),
            |_| Ok(()),
            |_| timezone_result,
        );
        let stderr = String::from_utf8(stderr).unwrap();

        assert_eq!(code, 0, "stderr={stderr}");
        assert!(stderr.contains(marker), "stderr={stderr}");
    }
}

#[test]
fn timezone_mode_rejects_invalid_arguments_before_operations() {
    let cases: &[&[&str]] = &[
        &[TIMEZONE_MODE_ARG],
        &[TIMEZONE_MODE_ARG, "UTC", "extra"],
        &[TIMEZONE_MODE_ARG, "../UTC"],
        &[TIMEZONE_MODE_ARG, "UTC;id"],
    ];

    for args in cases {
        let clock_called = Cell::new(false);
        let reseed_called = Cell::new(false);
        let timezone_called = Cell::new(false);
        let mut stderr = Vec::new();
        let code = run_with_operations(
            &b""[..],
            &mut stderr,
            args.iter().copied(),
            |_, _| {
                clock_called.set(true);
                Ok(())
            },
            |_| {
                reseed_called.set(true);
                Ok(())
            },
            |_| {
                timezone_called.set(true);
                Ok(true)
            },
        );

        assert_eq!(code, 1, "args={args:?}");
        assert!(!clock_called.get(), "args={args:?}");
        assert!(!reseed_called.get(), "args={args:?}");
        assert!(!timezone_called.get(), "args={args:?}");
        assert!(
            String::from_utf8(stderr).unwrap().contains("usage:"),
            "args={args:?}"
        );
    }
}

#[test]
fn restore_mode_runs_clock_reseed_and_timezone_in_order() {
    let events = RefCell::new(Vec::new());
    let entropy = [7u8; RESTORE_ENTROPY_BYTES];
    let mut stderr = Vec::new();

    let code = run_with_operations(
        &entropy[..],
        &mut stderr,
        [
            RESTORE_MODE_ARG,
            "123",
            "456000000",
            "required",
            "Asia/Shanghai",
        ],
        |seconds, nanoseconds| {
            events
                .borrow_mut()
                .push(format!("clock:{seconds}:{nanoseconds}"));
            Ok(())
        },
        |received| {
            assert_eq!(received, entropy);
            events.borrow_mut().push("reseed".to_string());
            Ok(())
        },
        |timezone| {
            events.borrow_mut().push(format!("timezone:{timezone}"));
            Ok(true)
        },
    );

    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    assert_eq!(
        events.into_inner(),
        ["clock:123:456000000", "reseed", "timezone:Asia/Shanghai"]
    );
}

#[test]
fn restore_mode_requires_exact_entropy_and_stops_before_clock() {
    for entropy in [
        vec![1; RESTORE_ENTROPY_BYTES - 1],
        vec![1; RESTORE_ENTROPY_BYTES + 1],
    ] {
        let clock_called = Cell::new(false);
        let mut stderr = Vec::new();
        let code = run_with_operations(
            &entropy[..],
            &mut stderr,
            [RESTORE_MODE_ARG, "123", "0", "none"],
            |_, _| {
                clock_called.set(true);
                Ok(())
            },
            |_| Ok(()),
            |_| Ok(true),
        );

        assert_eq!(code, 1);
        assert!(!clock_called.get());
        assert!(!stderr.is_empty());
    }
}

#[test]
fn restore_mode_stops_after_clock_or_reseed_failure() {
    let entropy = [3u8; RESTORE_ENTROPY_BYTES];
    let reseed_called = Cell::new(false);
    let timezone_called = Cell::new(false);
    let mut stderr = Vec::new();
    let code = run_with_operations(
        &entropy[..],
        &mut stderr,
        [RESTORE_MODE_ARG, "123", "0", "required", "UTC"],
        |_, _| Err(io::Error::other("clock denied")),
        |_| {
            reseed_called.set(true);
            Ok(())
        },
        |_| {
            timezone_called.set(true);
            Ok(true)
        },
    );
    assert_eq!(code, 1);
    assert!(!reseed_called.get());
    assert!(!timezone_called.get());
    assert!(
        String::from_utf8(stderr)
            .unwrap()
            .contains(CLOCK_SYNC_FAILED_MARKER)
    );

    let timezone_called = Cell::new(false);
    let mut stderr = Vec::new();
    let code = run_with_operations(
        &entropy[..],
        &mut stderr,
        [RESTORE_MODE_ARG, "123", "0", "required", "UTC"],
        |_, _| Ok(()),
        |_| Err(io::Error::other("ioctl denied")),
        |_| {
            timezone_called.set(true);
            Ok(true)
        },
    );
    assert_eq!(code, 1);
    assert!(!timezone_called.get());
    assert!(
        String::from_utf8(stderr)
            .unwrap()
            .contains(RESEED_FAILED_MARKER)
    );
}

#[test]
fn restore_mode_preserves_required_and_best_effort_timezone_failures() {
    let entropy = [5u8; RESTORE_ENTROPY_BYTES];
    for (mode, timezone_result, expected_code, marker) in [
        (
            "best-effort",
            Ok(false),
            0,
            Some(TIMEZONE_UNAVAILABLE_MARKER),
        ),
        (
            "best-effort",
            Err(io::Error::other("write denied")),
            0,
            Some(TIMEZONE_SYNC_FAILED_MARKER),
        ),
        ("required", Ok(false), 1, Some(TIMEZONE_UNAVAILABLE_MARKER)),
        (
            "required",
            Err(io::Error::other("write denied")),
            1,
            Some(TIMEZONE_SYNC_FAILED_MARKER),
        ),
    ] {
        let mut stderr = Vec::new();
        let code = run_with_operations(
            &entropy[..],
            &mut stderr,
            [RESTORE_MODE_ARG, "123", "0", mode, "UTC"],
            |_, _| Ok(()),
            |_| Ok(()),
            |_| timezone_result,
        );
        let stderr = String::from_utf8(stderr).unwrap();

        assert_eq!(code, expected_code, "mode={mode} stderr={stderr}");
        if let Some(marker) = marker {
            assert!(stderr.contains(marker), "mode={mode} stderr={stderr}");
        } else {
            assert!(stderr.is_empty(), "mode={mode} stderr={stderr}");
        }
    }
}

#[test]
fn restore_mode_rejects_invalid_timestamp_mode_and_timezone() {
    let cases: &[&[&str]] = &[
        &[RESTORE_MODE_ARG, "bad", "0", "none"],
        &[RESTORE_MODE_ARG, "1", "1000000000", "none"],
        &[RESTORE_MODE_ARG, "1", "0", "unknown"],
        &[RESTORE_MODE_ARG, "1", "0", "none", "UTC"],
        &[RESTORE_MODE_ARG, "1", "0", "required"],
        &[RESTORE_MODE_ARG, "1", "0", "required", "../UTC"],
    ];
    let entropy = [8u8; RESTORE_ENTROPY_BYTES];

    for args in cases {
        let mut stderr = Vec::new();
        let code = run_with_operations(
            &entropy[..],
            &mut stderr,
            args.iter().copied(),
            |_, _| Ok(()),
            |_| Ok(()),
            |_| Ok(true),
        );

        assert_eq!(code, 1, "args={args:?}");
        assert!(
            String::from_utf8(stderr).unwrap().contains("usage:"),
            "args={args:?}"
        );
    }
}

#[test]
fn timezone_sync_updates_guest_files_in_order_compatible_shape() {
    let root = tempfile::tempdir().unwrap();
    let zone = root.path().join("usr/share/zoneinfo/Asia/Shanghai");
    fs::create_dir_all(zone.parent().unwrap()).unwrap();
    fs::write(&zone, b"zone").unwrap();
    fs::create_dir_all(root.path().join("etc")).unwrap();
    fs::write(root.path().join("etc/timezone"), b"UTC\n").unwrap();
    fs::write(root.path().join("etc/localtime"), b"old").unwrap();
    fs::write(
        root.path().join("etc/environment"),
        b"PATH=/usr/bin\nTZ=UTC\nLANG=C",
    )
    .unwrap();

    assert!(sync_timezone_at(root.path(), "Asia/Shanghai").unwrap());

    assert_eq!(
        fs::read(root.path().join("etc/timezone")).unwrap(),
        b"Asia/Shanghai\n"
    );
    let localtime = root.path().join("etc/localtime");
    assert_eq!(
        fs::read_link(&localtime).unwrap(),
        Path::new("/usr/share/zoneinfo/Asia/Shanghai")
    );
    assert_eq!(
        fs::symlink_metadata(localtime).unwrap().mode() & libc::S_IFMT,
        libc::S_IFLNK
    );
    assert_eq!(
        fs::read(root.path().join("etc/environment")).unwrap(),
        b"PATH=/usr/bin\nLANG=C\nTZ=Asia/Shanghai\n"
    );
    assert!(!sync_timezone_at(root.path(), "Mars/Olympus").unwrap());
    assert!(!sync_timezone_at(root.path(), "/etc/passwd").unwrap());
}
