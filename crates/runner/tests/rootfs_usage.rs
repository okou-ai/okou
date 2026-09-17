use std::path::Path;
use std::process::Command;

#[test]
fn rootfs_usage_command_preserves_bounded_filesystem_evidence() {
    let tests = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/rootfs_usage_tests.py");
    let output = Command::new("python3")
        .args(["-I", "-B"])
        .arg(tests)
        .output()
        .expect("Python 3 is required for the guest diagnostic command tests");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
