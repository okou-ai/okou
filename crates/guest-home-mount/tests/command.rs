use std::process::Command;

#[test]
fn command_rejects_caller_selected_paths_before_mounting() {
    let output = Command::new(env!("CARGO_BIN_EXE_guest-home-mount"))
        .args(["--device", "/dev/vda"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(64));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("accepts no arguments"));
}
