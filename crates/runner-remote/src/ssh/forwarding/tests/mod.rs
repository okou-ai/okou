use super::*;

#[test]
fn target_requires_canonical_unambiguous_host_and_nonzero_port() {
    for host in [
        "desktop.internal",
        "LOCALHOST",
        "127.0.0.1",
        "10.0.0.1",
        "2001:db8::1",
        "::1",
    ] {
        assert_eq!(validate_target(host, 5900), Ok(()), "accepted: {host}");
    }
    for host in [
        "",
        "desktop.internal.",
        "127.1",
        "2130706433",
        "0x7f000001",
        "127.000.000.001",
        "2001:0db8::1",
        "[2001:db8::1]",
        "fe80::1%eth0",
        "https://desktop.internal",
        "user@desktop.internal",
        "desktop.internal:5900",
        "desktop.internal/path",
        "desktop\\internal",
        "desktop..internal",
        "-desktop.internal",
        "desktop-.internal",
        "desktop.internal ",
        "d\u{e9}sktop.internal",
    ] {
        assert_eq!(
            validate_target(host, 5900),
            Err(FailureReason::UnsafeDestination),
            "rejected: {host}"
        );
    }
    assert_eq!(
        validate_target("desktop.internal", 0),
        Err(FailureReason::UnsafeDestination)
    );
    assert_eq!(
        validate_target(&format!("{}.internal", "a".repeat(244)), 5900),
        Err(FailureReason::UnsafeDestination)
    );
}
