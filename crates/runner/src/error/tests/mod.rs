use super::*;

#[test]
fn host_service_errors_preserve_runner_categories_display_and_io_source() {
    use runner_host::service::{RunnerServiceUnit, journalctl_logs_status};
    use std::error::Error;
    use std::os::unix::process::ExitStatusExt;

    let config = RunnerServiceUnit::from_suffix("UPPER").unwrap_err();
    let expected = config.to_string();
    let mapped = RunnerError::from(config);
    assert!(matches!(&mapped, RunnerError::Config(_)));
    assert_eq!(mapped.to_string(), expected);

    let internal = journalctl_logs_status(
        "vm0-runner-test.service",
        std::process::ExitStatus::from_raw(1 << 8),
    )
    .unwrap_err();
    let expected = internal.to_string();
    let mapped = RunnerError::from(internal);
    assert!(matches!(&mapped, RunnerError::Internal(_)));
    assert_eq!(mapped.to_string(), expected);

    let io = std::io::Error::from_raw_os_error(libc::EACCES);
    let expected_source = io.to_string();
    let host = runner_host::HostError::Io(io);
    let expected_display = host.to_string();
    let mapped = RunnerError::from(host);
    assert_eq!(mapped.to_string(), expected_display);
    assert_eq!(mapped.source().unwrap().to_string(), expected_source);
    assert!(matches!(mapped, RunnerError::Io(ref io)
        if io.raw_os_error() == Some(libc::EACCES)
            && io.kind() == std::io::ErrorKind::PermissionDenied));
}

#[test]
fn reactor_errors_preserve_root_categories_display_and_io_source() {
    use runner_supervisor::reactor::error::ReactorError;
    use std::error::Error;
    let cases = [
        (
            ReactorError::Host(runner_host::HostError::Config("host".into())),
            RunnerError::Config("host".into()),
        ),
        (
            ReactorError::Provider(runner_provider::ProviderError::Api("provider".into())),
            RunnerError::Api("provider".into()),
        ),
        (
            ReactorError::Lifecycle(runner_lifecycle::LifecycleError::Internal(
                "lifecycle".into(),
            )),
            RunnerError::Internal("lifecycle".into()),
        ),
        (
            ReactorError::Network(runner_network::NetworkError::Internal("network".into())),
            RunnerError::Internal("network".into()),
        ),
        (
            ReactorError::Executor(runner_executor::ExecutorError::Config("executor".into())),
            RunnerError::Config("executor".into()),
        ),
        (
            ReactorError::Internal("reactor".into()),
            RunnerError::Internal("reactor".into()),
        ),
    ];
    for (error, expected) in cases {
        let mapped = RunnerError::from(error);
        assert_eq!(
            std::mem::discriminant(&mapped),
            std::mem::discriminant(&expected)
        );
        assert_eq!(mapped.to_string(), expected.to_string());
    }
    let mapped = RunnerError::from(runner_storage::StorageError::Cancelled);
    let expected = RunnerError::Cancelled;
    assert_eq!(
        std::mem::discriminant(&mapped),
        std::mem::discriminant(&expected)
    );
    assert_eq!(mapped.to_string(), expected.to_string());
    let io = std::io::Error::from_raw_os_error(libc::EACCES);
    let expected = io.to_string();
    let mapped = RunnerError::from(ReactorError::Host(runner_host::HostError::Io(io)));
    assert_eq!(mapped.to_string(), format!("io error: {expected}"));
    assert_eq!(mapped.source().unwrap().to_string(), expected);
    assert!(matches!(mapped, RunnerError::Io(ref io) if io.raw_os_error() == Some(libc::EACCES)));
    let mapped = RunnerError::from(ReactorError::Sandbox(
        sandbox::SandboxError::Initialization {
            phase: sandbox::SandboxInitializationPhase::Factory,
            message: "factory".into(),
        },
    ));
    assert!(matches!(
        mapped,
        RunnerError::Sandbox(sandbox::SandboxError::Initialization {
            phase: sandbox::SandboxInitializationPhase::Factory,
            ..
        })
    ));
}

#[test]
fn format_short_duration_cases() {
    assert_eq!(format_short_duration(Duration::from_secs(0)), "0m");
    assert_eq!(format_short_duration(Duration::from_secs(45)), "0m");
    assert_eq!(format_short_duration(Duration::from_secs(600)), "10m");
    assert_eq!(format_short_duration(Duration::from_secs(3600)), "1h00m");
    assert_eq!(format_short_duration(Duration::from_secs(7260)), "2h01m");
}

#[test]
fn active_jobs_error_display_singular() {
    let err = ActiveJobsError {
        unit: "vm0-runner-v0.3.0".into(),
        suffix: "v0.3.0".into(),
        run_ids: vec![RunId::from(uuid::Uuid::nil())],
        runner_uptime: Duration::from_secs(600),
        command_name: "stop",
        draining: false,
    };
    let s = format!("{err}");
    // Singular phrasing, no "(s)" stutter and no "1 jobs"
    assert!(s.contains("1 active job"), "got:\n{s}");
    assert!(!s.contains("job(s)"), "got:\n{s}");
    assert!(!s.contains("1 active jobs"), "got:\n{s}");
    // Uptime is shown once (at the runner level), not per-job
    assert!(s.contains("up 10m"), "got:\n{s}");
    assert!(s.contains("runner service drain --name v0.3.0"));
    assert!(s.contains("--force"));
    assert!(!s.contains("already draining"));
}

#[test]
fn active_jobs_error_display_plural() {
    let err = ActiveJobsError {
        unit: "vm0-runner-v0.3.0".into(),
        suffix: "v0.3.0".into(),
        run_ids: vec![
            RunId::from(uuid::Uuid::nil()),
            RunId::from(uuid::Uuid::nil()),
        ],
        runner_uptime: Duration::from_secs(7260),
        command_name: "uninstall",
        draining: false,
    };
    let s = format!("{err}");
    assert!(s.contains("2 active jobs"), "got:\n{s}");
    assert!(!s.contains("job(s)"), "got:\n{s}");
    assert!(s.contains("up 2h01m"), "got:\n{s}");
    assert!(s.contains("uninstall anyway"));
}

#[test]
fn active_jobs_error_display_draining() {
    let err = ActiveJobsError {
        unit: "vm0-runner-v0.3.0".into(),
        suffix: "v0.3.0".into(),
        run_ids: vec![RunId::from(uuid::Uuid::nil())],
        runner_uptime: Duration::from_secs(1800),
        command_name: "stop",
        draining: true,
    };
    let s = format!("{err}");
    assert!(s.contains("is already draining"), "got:\n{s}");
    assert!(s.contains("1 active job"), "got:\n{s}");
    assert!(!s.contains("job(s)"), "got:\n{s}");
    assert!(s.contains("up 30m"), "got:\n{s}");
    assert!(s.contains("Wait for the drain to finish"));
    assert!(s.contains("--force"));
    assert!(
        !s.contains("runner service drain --name"),
        "should not suggest drain when already draining; got:\n{s}"
    );
}
