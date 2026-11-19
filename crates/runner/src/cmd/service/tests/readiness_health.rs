use raw_http_test_support::raw_http::{RawHttpAction, RawHttpTestServer, http_response};
use tokio::sync::oneshot;

use super::*;

const SCENARIO_ENV: &str = "OKOU_WAIT_RUNNING_HEALTH_SCENARIO";
const ROOT_ENV: &str = "OKOU_WAIT_RUNNING_HEALTH_ROOT";
const CHILD_TEST: &str = "cmd::service::tests::readiness_health::wait_running_health_child";

const SYSTEMCTL: &str = r#"#!/bin/sh
root=$OKOU_WAIT_RUNNING_HEALTH_ROOT
case "$1:$2" in
  --no-pager:cat)
    if [ -f "$root/cat-called" ]; then
      exec sleep 60
    fi
    touch "$root/cat-called"
    printf '[Service]\nExecStart=/usr/local/bin/runner start --config "%s/runner.yaml"\n' "$root"
    ;;
  show:*)
    printf 'LoadState=loaded\nActiveState=active\n'
    ;;
  *)
    printf 'unexpected systemctl invocation: %s\n' "$*" >&2
    exit 2
    ;;
esac
"#;

#[tokio::test]
async fn wait_running_health_reuses_the_selected_instance() {
    run_scenario("healthy").await;
}

#[tokio::test]
async fn wait_running_health_rejects_persistent_warnings() {
    run_scenario("unhealthy").await;
}

#[tokio::test]
async fn wait_running_health_rejects_a_runner_removed_during_verification() {
    run_scenario("withdrawn").await;
}

async fn run_scenario(scenario: &str) {
    let temp = tempfile::tempdir().unwrap();
    let systemctl = temp.path().join("systemctl");
    std::fs::write(&systemctl, SYSTEMCTL).unwrap();
    std::fs::set_permissions(systemctl, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!(
        "{}:{}",
        temp.path().display(),
        std::env::var("PATH").expect("test process PATH must be set")
    );
    run_ignored_child_test(
        CHILD_TEST,
        (SCENARIO_ENV, scenario),
        &[
            ("PATH", Some(&path)),
            (ROOT_ENV, Some(utf8_path(temp.path()))),
        ],
        Duration::from_secs(25),
    )
    .await;
}

#[tokio::test]
#[ignore = "spawned by the isolated wait-running health tests"]
async fn wait_running_health_child() {
    let Ok(scenario) = std::env::var(SCENARIO_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((SCENARIO_ENV, &scenario)) {
        return;
    }

    let root = PathBuf::from(std::env::var(ROOT_ENV).unwrap());
    let home = HomePaths::with_root(root.join("home"));
    let base_dir = root.join("instance");
    let config_path = root.join("runner.yaml");
    std::fs::create_dir(&base_dir).unwrap();
    let mut status = serde_json::json!({
        "mode": "running",
        "max_concurrent": 35,
        "started_at": "2026-01-01T00:00:00.000Z",
    });
    if scenario == "unhealthy" {
        // No listening proxy can own port 0.
        status["proxy_port"] = 0.into();
    }
    std::fs::write(base_dir.join("status.json"), status.to_string()).unwrap();
    let instance = crate::live_runner_instances::publish(
        &home,
        crate::live_runner_instances::LiveRunnerInstanceMetadata {
            config_path: config_path.clone(),
            base_dir: base_dir.clone(),
            runner_group: "vm0/test".into(),
            subcommand: "start".into(),
        },
    )
    .await
    .unwrap();

    let args = ServiceWaitRunningArgs {
        name: "test".into(),
        timeout_secs: 12,
        check_health: true,
    };
    if scenario == "withdrawn" {
        let (release, response) = oneshot::channel();
        let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitThenRespond {
            release: response,
            response: http_response("200 OK", b""),
        }])
        .await;
        let config = serde_json::json!({
            "group": "vm0/test",
            "base_dir": base_dir,
            "ca_dir": root.join("ca"),
            "firecracker": { "binary": "firecracker", "kernel": "vmlinux" },
            "profiles": {},
            "server": { "url": server.url(), "token": "test-token" },
        });
        std::fs::write(config_path, config.to_string()).unwrap();
        let result = wait_running(args, &home);
        tokio::pin!(result);
        tokio::select! {
            request = server.next_request("doctor HEAD probe") => {
                assert!(request.starts_with("HEAD "));
            }
            result = &mut result => panic!("health check returned before its probe: {result:?}"),
        }
        assert!(instance.remove_if_current().await.unwrap());
        release.send(()).unwrap();
        let error = result.await.unwrap_err().to_string();
        assert!(
            error.contains("exited or was replaced during health verification"),
            "{error}"
        );
        server.assert_finished().await;
    } else {
        let result = wait_running(args, &home).await;
        if scenario == "healthy" {
            assert_eq!(result.unwrap(), 35);
        } else {
            let error = result.unwrap_err().to_string();
            assert!(
                error.contains("failed runner health verification"),
                "{error}"
            );
        }
    }
    assert!(root.join("cat-called").exists());
}
