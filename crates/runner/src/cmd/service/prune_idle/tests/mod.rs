use super::*;
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};
use clap::Parser;
use std::os::unix::fs::PermissionsExt;

const SCENARIO: &str = "RUNNER_PRUNE_IDLE_SCENARIO";
const CHILD: &str = "cmd::service::prune_idle::tests::prune_idle_command_child";

#[tokio::test]
async fn prune_idle_command_resolves_exact_service_and_reports_results() {
    for scenario in ["completed", "uncertain", "stale"] {
        let dir = tempfile::tempdir().unwrap();
        let systemctl = dir.path().join("systemctl");
        tokio::fs::write(&systemctl, "#!/bin/sh\nprintf '[Service]\\nExecStart=/runner start --config %s\\n' \"$PRUNE_TEST_CONFIG\"\n").await.unwrap();
        tokio::fs::set_permissions(&systemctl, std::fs::Permissions::from_mode(0o755))
            .await
            .unwrap();
        let config = dir.path().join("config.yaml");
        let config_text = config.to_str().unwrap();
        run_ignored_child_test(
            CHILD,
            (SCENARIO, scenario),
            &[
                ("PATH", Some(dir.path().to_str().unwrap())),
                ("PRUNE_TEST_CONFIG", Some(config_text)),
            ],
            Duration::from_secs(10),
        )
        .await;
    }
}

#[tokio::test]
#[ignore = "spawned by prune_idle_command_resolves_exact_service_and_reports_results"]
async fn prune_idle_command_child() {
    let scenario = std::env::var(SCENARIO).unwrap_or_default();
    if !ignored_child_test_env_guard_enabled((SCENARIO, &scenario)) || scenario.is_empty() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let identity = RunnerProcessIdentity::new(Uuid::new_v4(), 7).unwrap();
    let _live = crate::live_runner_instances::publish(
        &home,
        crate::live_runner_instances::LiveRunnerInstanceMetadata {
            config_path: std::env::var("PRUNE_TEST_CONFIG").unwrap().into(),
            base_dir: dir.path().to_path_buf(),
            runner_group: "test".into(),
            subcommand: "start".into(),
        },
    )
    .await
    .unwrap();
    let listener =
        idle_prune_control::PruneIdleListener::bind(&home, dir.path(), identity).unwrap();
    let generation = if scenario == "stale" { "6" } else { "7" };
    let cli = crate::Cli::try_parse_from([
        "runner",
        "service",
        "prune-idle",
        "--name",
        "pr-123-1",
        "--expected-runner-id",
        &identity.runner_id().to_string(),
        "--expected-heartbeat-generation",
        generation,
    ])
    .unwrap();
    let crate::Command::Service(service) = cli.command else {
        panic!("expected service command")
    };
    let super::super::ServiceCommand::PruneIdle(args) = service.command else {
        panic!("expected prune command")
    };
    let uncertain = usize::from(scenario == "uncertain");
    let server = tokio::spawn(async move {
        let mut stream = listener.accept().await.unwrap();
        idle_prune_control::read_request(&mut stream, identity)
            .await
            .unwrap();
        idle_prune_control::write_response(
            &mut stream,
            &Ok(idle_prune_control::PruneIdleReport {
                selected: 1,
                completed: 1 - uncertain,
                uncertain,
            }),
        )
        .await
        .unwrap();
    });
    let result = run_with_home(args, &home).await;
    match scenario.as_str() {
        "completed" => result.unwrap(),
        "uncertain" => assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("could not confirm")
        ),
        "stale" => {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("expected Runner generation")
            );
            server.abort();
            assert!(server.await.unwrap_err().is_cancelled());
            return;
        }
        _ => panic!("unknown scenario"),
    }
    server.await.unwrap();
}
