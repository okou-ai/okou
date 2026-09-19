use super::super::super::*;
use super::super::support::{
    mock_run_config_with_overrides, push_job, shutdown, test_profiles, wait_cancel_handle,
    wait_idle_pool_len,
};
use super::blank_session_history::history_context;
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, http_response};
use crate::types::{FirewallEntry, SandboxReuseResult};
use sandbox::{SandboxError, SandboxOperation, SandboxOperationTimeoutStage};
use sandbox_mock::{MockLifecycleGate, MockSandboxOverrides};
use tokio::sync::oneshot;

const WAIT: Duration = Duration::from_secs(5);
const HISTORY: &[u8] = br#"{"type":"session_meta","payload":{"id":"019e9154-c304-70f0-adde-36efb1be1701","timestamp":"2026-07-13T01:02:03Z"}}"#;

#[tokio::test]
async fn blank_prefetch_recovery_preserves_history_identity_budget_and_one_completion() {
    for cancelled in [false, true] {
        let (release_history, history_release) = oneshot::channel();
        let history_action = if cancelled {
            RawHttpAction::WaitForDisconnect
        } else {
            RawHttpAction::WaitThenRespond {
                release: history_release,
                response: http_response("200 OK", HISTORY),
            }
        };
        let mut server = RawHttpTestServer::spawn(vec![history_action]).await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        let (config, env) =
            mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, Arc::clone(&overrides));
        let admission = config.exec_config.pre_spawn_admission.clone();
        let budget = Arc::clone(&config.capacity.budget);
        let run_handle = tokio::spawn(run(config));
        wait_idle_pool_len(&env.idle_pool, 1, WAIT).await;
        let holder = admission
            .acquire(u32::MAX, &CancellationToken::new())
            .await
            .unwrap();
        let blank_id = env.idle_pool.lock().await.status_snapshot().blank_sandboxes[0].sandbox_id;
        let run_id = RunId::new_v4();
        let mut context = history_context(run_id, server.url(), HISTORY);
        context.cli_agent_type = "codex".into();
        context
            .resume_session
            .as_mut()
            .unwrap()
            .cli_agent_session_id = "019e9154-c304-70f0-adde-36efb1be1701".into();
        context.encrypted_secrets = Some("encrypted".into());
        context.firewalls = Some(vec![FirewallEntry::Builtin {
            name: "model-provider:codex-oauth-token".into(),
            base_url_vars: None,
            source_id: None,
        }]);
        overrides.push_start_process_error(SandboxError::OperationTimeout {
            operation: SandboxOperation::StartProcess,
            stage: SandboxOperationTimeoutStage::AwaitingTerminalResponse,
            timeout_ms: 1_000,
        });
        let destroy = MockLifecycleGate::new();
        overrides.set_destroy_lifecycle_gate(destroy.clone());
        push_job(&env, run_id, "vm0/default", Some(context));
        destroy.wait_entered(1, WAIT).await.unwrap();
        env.drain();
        server
            .next_request("history prestarted before blank retirement")
            .await;
        assert_eq!(overrides.create_configs().len(), 1);
        assert_eq!(budget.allocated().2, 1);
        assert!(env.active_runs.contains(run_id));
        assert!(overrides.write_file_calls().is_empty());
        assert!(overrides.start_agent_process_calls().is_empty());
        assert!(env.handle.completions.lock().unwrap().is_empty());
        drop(holder);

        if cancelled {
            let cancellation = wait_cancel_handle(&env.cancel_tokens, run_id, WAIT).await;
            cancellation.request_hard_cancellation().await;
            destroy.release_one();
        } else {
            destroy.release_one();
            release_history.send(()).unwrap();
            // The successful replacement is destroyed by ordinary finalization.
            destroy.wait_entered(2, WAIT).await.unwrap();
            destroy.release_one();
        }
        let completion = env.handle.wait_completion(run_id, WAIT).await.unwrap();
        assert_eq!(completion.exit_code, if cancelled { 137 } else { 0 });
        assert_eq!(completion.sandbox_id, Some(blank_id));
        assert_eq!(
            completion.reuse_result,
            Some(SandboxReuseResult::NoReuseKey)
        );
        assert_eq!(overrides.start_process_calls().len(), 1);
        assert_eq!(
            overrides.start_agent_process_calls().len(),
            usize::from(!cancelled)
        );
        let creates = overrides.create_configs();
        assert_eq!(creates.len(), if cancelled { 1 } else { 2 });
        assert!(creates.iter().all(|config| config.id == blank_id));
        let writes = overrides.write_file_calls();
        assert_eq!(
            writes.len(),
            usize::from(!cancelled),
            "restore retained history exactly once, and never after cancellation"
        );
        if !cancelled {
            assert_eq!(writes[0].content, HISTORY);
            assert_eq!(
                writes[0].path,
                "/home/user/.codex/sessions/2026/07/13/rollout-2026-07-13T01-02-03-019e9154-c304-70f0-adde-36efb1be1701.jsonl"
            );
        }
        server.assert_finished().await;
        shutdown(&env, run_handle).await;
        assert_eq!(budget.allocated().2, 0);
        assert!(!env.active_runs.contains(run_id));
        assert_eq!(env.handle.completions.lock().unwrap().len(), 1);
    }
}
