use super::*;

#[test]
fn socket_paths_fit_sun_path_limit() {
    let runtime = RuntimePaths::new();
    let uuid = "550e8400-e29b-41d4-a716-446655440000";
    let sock = SockPaths::new(runtime.sock_dir(uuid));

    let api = sock.api_sock();
    let vsock = sock.vsock();

    // sun_path limit is 108 bytes (including NUL terminator), so max usable = 107.
    assert!(
        api.as_os_str().len() <= 107,
        "api.sock path too long: {} bytes ({})",
        api.as_os_str().len(),
        api.display()
    );
    assert!(
        vsock.as_os_str().len() <= 107,
        "vsock.sock path too long: {} bytes ({})",
        vsock.as_os_str().len(),
        vsock.display()
    );
}

#[test]
fn control_socket_path_fits_sun_path_limit() {
    let runtime = RuntimePaths::new();
    let uuid = "550e8400-e29b-41d4-a716-446655440000";
    let sock = SockPaths::new(runtime.sock_dir(uuid));

    let control = sock.control_sock();
    assert!(
        control.as_os_str().len() <= 107,
        "control.sock path too long: {} bytes ({})",
        control.as_os_str().len(),
        control.display()
    );
}

#[test]
fn snapshot_socket_paths_fit_sun_path_limit() {
    // Worst case: full SHA-256 hex hash (64 chars) as output dir name.
    let sha256 = "a".repeat(64);
    let runtime = RuntimePaths::new();
    let sock = SockPaths::new(runtime.sock_dir(&sha256));

    let api = sock.api_sock();
    let vsock = sock.vsock();
    let control_listener = format!("{}_{}", vsock.display(), guest_control_proto::VSOCK_PORT);

    assert!(
        api.as_os_str().len() <= 107,
        "snapshot api.sock path too long: {} bytes ({})",
        api.as_os_str().len(),
        api.display()
    );
    assert!(
        vsock.as_os_str().len() <= 107,
        "snapshot vsock.sock path too long: {} bytes ({})",
        vsock.as_os_str().len(),
        vsock.display()
    );
    assert!(
        control_listener.len() <= 107,
        "snapshot control listener path too long: {control_listener}"
    );
}

#[test]
fn snapshot_control_listener_id_length_boundary() {
    let runtime = RuntimePaths::new();
    let control_listener_len = |id_length| {
        let sock = SockPaths::new(runtime.sock_dir(&"a".repeat(id_length)));
        format!(
            "{}_{}",
            sock.vsock().display(),
            guest_control_proto::VSOCK_PORT
        )
        .len()
    };

    // The Linux sun_path array has 108 bytes including the terminating NUL.
    assert_eq!(control_listener_len(70), 107);
    assert_eq!(control_listener_len(71), 108);
}

/// Guard against using a composite `<rootfs>/<snapshot>` as sock_id.
/// That would exceed 107 bytes (sun_path limit) and fail at bind time.
#[test]
fn composite_sock_id_would_overflow_sun_path() {
    let rootfs = "a".repeat(64);
    let snapshot = "b".repeat(64);
    let composite = format!("{rootfs}/{snapshot}");
    let runtime = RuntimePaths::new();
    let sock = SockPaths::new(runtime.sock_dir(&composite));
    let vsock = sock.vsock();
    assert!(
        vsock.as_os_str().len() > 107,
        "composite sock_id MUST overflow sun_path — if this fails, the guard is stale: {} bytes ({})",
        vsock.as_os_str().len(),
        vsock.display()
    );
}

#[test]
fn cow_bitmap_consistent_with_cow() {
    let output = SnapshotOutputPaths::new(PathBuf::from("/data/images/abc123"));
    let expected = PathBuf::from(format!("{}.bitmap", output.cow().display()));
    assert_eq!(
        output.cow_bitmap(),
        expected,
        "cow_bitmap() must be cow() + \".bitmap\" suffix"
    );
}

#[test]
fn complete_marker_path_is_hidden_in_output_dir() {
    let output = SnapshotOutputPaths::new(PathBuf::from("/data/images/abc123"));
    assert_eq!(
        output.complete_marker(),
        PathBuf::from("/data/images/abc123/.snapshot-complete")
    );
}
