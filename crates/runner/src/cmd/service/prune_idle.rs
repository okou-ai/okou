use std::time::Duration;

use clap::Args;
use uuid::Uuid;

use crate::error::{RunnerError, RunnerResult};
use crate::idle_prune_control;
use crate::paths::HomePaths;
use crate::runner_process_identity::RunnerProcessIdentity;

use super::{RunnerServiceUnit, read_unit_config_path, selected_config_live_instance};

#[derive(Args)]
pub(super) struct PruneIdleArgs {
    /// Exact service suffix; never selects other Runner services
    #[arg(long)]
    name: String,
    /// Runner UUID captured when the target deployment became ready
    #[arg(long)]
    expected_runner_id: Uuid,
    /// Process generation captured with --expected-runner-id
    #[arg(long)]
    expected_heartbeat_generation: u64,
    /// Whole-command deadline; admitted cleanup continues after client timeout
    #[arg(long, default_value_t = 120, value_parser = clap::value_parser!(u64).range(1..=3600))]
    timeout_secs: u64,
}

pub(super) async fn run(args: PruneIdleArgs) -> RunnerResult<()> {
    run_with_home(args, &HomePaths::new()?).await
}

async fn run_with_home(args: PruneIdleArgs, home: &HomePaths) -> RunnerResult<()> {
    let unit = RunnerServiceUnit::from_suffix(&args.name)?;
    let identity =
        RunnerProcessIdentity::new(args.expected_runner_id, args.expected_heartbeat_generation)
            .map_err(|error| RunnerError::Config(error.to_string()))?;
    let report = tokio::time::timeout(Duration::from_secs(args.timeout_secs), async {
        let config = read_unit_config_path(&unit).await?.ok_or_else(|| {
            RunnerError::Internal("service has no Runner config; nothing was pruned".into())
        })?;
        let instance = selected_config_live_instance(&unit, &config, home).await?.ok_or_else(|| {
            RunnerError::Internal("service has no live Runner process; nothing was pruned".into())
        })?;
        idle_prune_control::request(home, &instance.base_dir, identity, instance.pid).await
            .map_err(|error| RunnerError::Internal(format!(
                "could not prune the expected Runner generation: {error}; verify the deployment identity and command support"
            )))?
            .map_err(RunnerError::Internal)
    }).await.map_err(|_| RunnerError::Internal(
        "idle prune command timed out; admitted cleanup may still be running".into()
    ))??;
    println!(
        "{}",
        serde_json::to_string(&report).map_err(|error| RunnerError::Internal(error.to_string()))?
    );
    if report.uncertain > 0 {
        return Err(RunnerError::Internal(
            "idle pruning could not confirm all destructions; inspect Runner logs".into(),
        ));
    }
    Ok(())
}

runner_test_group!(cmd_service; #[cfg(test)]
mod tests {
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
});
