use super::*;

const SCENARIO_ENV: &str = "OKOU_TEST_UNINSTALL_SHUTDOWN_SCENARIO";
const INVOCATIONS_ENV: &str = "OKOU_TEST_UNINSTALL_SHUTDOWN_INVOCATIONS";
const CHILD_TEST: &str = "cmd::service::tests::teardown::uninstall_shutdown_child";
const UNIT_CONTENT: &[u8] =
    b"[Service]\nExecStart=/opt/okou/runner start\n# uninstall retention sentinel\n";
const SYSTEMCTL: &str = r#"#!/bin/sh
set -eu
printf '%s\n' "$1" >> "$OKOU_TEST_UNINSTALL_SHUTDOWN_INVOCATIONS"
case "$1" in
  stop)
    printf '%s\n' 'stop client failed' >&2
    exit 1
    ;;
  show)
    case "$OKOU_TEST_UNINSTALL_SHUTDOWN_SCENARIO" in
      deactivating) printf 'LoadState=loaded\nActiveState=deactivating\n' ;;
      unknown) printf '%s\n' 'systemd unavailable' >&2; exit 1 ;;
      *) exit 2 ;;
    esac
    ;;
  *) printf 'unexpected teardown command: %s\n' "$*" >&2; exit 2 ;;
esac
"#;

#[tokio::test]
async fn uninstall_preserves_unit_when_failed_stop_leaves_deactivating_or_unknown_state() {
    for scenario in ["deactivating", "unknown"] {
        let dir = tempfile::tempdir().unwrap();
        let systemctl = dir.path().join("systemctl");
        std::fs::write(&systemctl, SYSTEMCTL).unwrap();
        std::fs::set_permissions(&systemctl, std::fs::Permissions::from_mode(0o755)).unwrap();
        let invocations = dir.path().join("invocations");
        run_ignored_child_test(
            CHILD_TEST,
            (SCENARIO_ENV, scenario),
            &[
                ("PATH", Some(dir.path().to_str().unwrap())),
                (INVOCATIONS_ENV, Some(invocations.to_str().unwrap())),
            ],
            Duration::from_secs(10),
        )
        .await;
        // Disable and reload would cross the artifact-removal boundary.
        assert_eq!(
            std::fs::read_to_string(invocations).unwrap(),
            "stop\nshow\n"
        );
    }
}

#[tokio::test]
#[ignore = "spawned with a private systemctl fixture by the uninstall shutdown test"]
async fn uninstall_shutdown_child() {
    let Ok(scenario) = std::env::var(SCENARIO_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((SCENARIO_ENV, &scenario)) {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    // Exercise the real uninstall entry with an installed unit, without writing
    // to the host's systemd directory.
    let unit = RunnerServiceUnit::from_suffix(&format!("test-uninstall-{}", std::process::id()))
        .unwrap()
        .with_unit_file_dir_for_test(dir.path());
    std::fs::write(unit.unit_file_path(), UNIT_CONTENT).unwrap();

    let error = uninstall_service_unit(&unit).await.unwrap_err().to_string();
    assert!(error.contains(unit.unit_name()), "{error}");
    assert!(error.contains("refusing to remove unit files"), "{error}");
    assert!(error.contains("systemctl"), "{error}");
    match scenario.as_str() {
        "deactivating" => assert!(error.contains("remains deactivating"), "{error}"),
        "unknown" => assert!(error.contains("could not verify it is inactive"), "{error}"),
        unexpected => panic!("unexpected uninstall scenario: {unexpected}"),
    }
    assert_eq!(
        std::fs::read(unit.unit_file_path())
            .expect("refused uninstall must retain the installed unit file"),
        UNIT_CONTENT,
        "{scenario}: refused uninstall changed the installed unit"
    );
}
