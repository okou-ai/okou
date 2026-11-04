use super::*;
use std::ffi::OsStr;

fn args(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

#[test]
fn private_channel_is_mandatory_and_program_inputs_are_preserved() {
    let parsed = invocation(&args(&[
        "--report-fd",
        "3",
        "--",
        "/bin/python3",
        "-c",
        "a b",
        "",
    ]))
    .unwrap();
    assert!(
        matches!(parsed, Invocation::Launch { report_fd: 3, program, arguments } if program == OsStr::new("/bin/python3") && arguments == args(&["-c", "a b", ""]))
    );
    for values in [
        vec![],
        vec!["--report-fd", "1", "--", "true"],
        vec!["--report-fd", "-3", "--", "true"],
        vec!["--report-fd", "3", "true"],
        vec!["--report-fd", "3", "--", ""],
        vec!["stop", "1"],
    ] {
        assert!(invocation(&args(&values)).is_err());
    }
}

#[test]
fn closed_and_standard_report_fds_fail_before_connect() {
    assert!(report_pipe(-1).is_err());
    let read_only = File::open("/dev/null").unwrap();
    assert!(report_pipe(read_only.as_raw_fd()).is_err());
}
