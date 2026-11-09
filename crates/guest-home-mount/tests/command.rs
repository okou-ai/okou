use std::process::Command;

#[test]
fn command_rejects_caller_selected_paths_before_mounting() {
    let rejected: &[&[&str]] = &[
        &["--device", "/dev/vda"],
        &["--unmount", "/dev/vda"],
        &["--unmount", "--force"],
        &["/home/user"],
    ];
    for args in rejected {
        let output = Command::new(env!("CARGO_BIN_EXE_guest-home-mount"))
            .args(*args)
            .output()
            .unwrap();

        assert_eq!(output.status.code(), Some(64), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        assert_eq!(
            String::from_utf8_lossy(&output.stderr).trim(),
            "unsupported home helper operation",
            "{args:?}"
        );
    }
}
