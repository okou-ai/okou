use super::*;
use crate::executor::tests::support::RUN_IN_SANDBOX_TEST_TIMEOUT;
use crate::executor::{SandboxReuseDisposition, SandboxReuseRejection};
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, http_response};

fn capture_proxy_register_events(action: impl FnOnce()) -> Vec<CapturedEvent> {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    tracing::subscriber::with_default(subscriber, action);
    captured.entries()
}

fn assert_event_field(event: &CapturedEvent, field: &str, expected: &str) {
    let actual = event
        .fields
        .get(field)
        .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
    assert_eq!(actual, expected, "field {field} mismatch; event={event:#?}");
}
#[test]
fn proxy_register_fast_success_logs_info() {
    let events = capture_proxy_register_events(|| {
        log_proxy_register_success(
            RunId::nil(),
            SandboxId::from(uuid::Uuid::nil()),
            "vm0/default",
            Duration::from_secs(1),
        );
    });

    assert_eq!(events.len(), 1, "events: {events:#?}");
    let event = &events[0];
    assert_eq!(event.level, Level::INFO);
    assert_event_field(event, "message", "proxy register timing");
    assert_event_field(event, "stage", "proxy_register");
    assert_event_field(event, "elapsed_ms", "1000");
    assert_event_field(event, "threshold_ms", "3000");
    assert_event_field(event, "success", "true");
    assert_event_field(event, "run_id", "00000000-0000-0000-0000-000000000000");
    assert_event_field(event, "sandbox_id", "00000000-0000-0000-0000-000000000000");
    assert_event_field(event, "profile", "vm0/default");
}

#[test]
fn proxy_register_slow_success_warns_with_stable_fields() {
    let events = capture_proxy_register_events(|| {
        log_proxy_register_success(
            RunId::nil(),
            SandboxId::from(uuid::Uuid::nil()),
            "vm0/default",
            Duration::from_secs(3),
        );
    });

    assert_eq!(events.len(), 1, "events: {events:#?}");
    let event = &events[0];
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "message", "slow proxy register");
    assert_event_field(event, "stage", "proxy_register");
    assert_event_field(event, "elapsed_ms", "3000");
    assert_event_field(event, "threshold_ms", "3000");
    assert_event_field(event, "success", "true");
    assert_event_field(event, "run_id", "00000000-0000-0000-0000-000000000000");
    assert_event_field(event, "sandbox_id", "00000000-0000-0000-0000-000000000000");
    assert_event_field(event, "profile", "vm0/default");
}

#[test]
fn proxy_register_failure_warns_with_error() {
    let events = capture_proxy_register_events(|| {
        log_proxy_register_failure(
            RunId::nil(),
            SandboxId::from(uuid::Uuid::nil()),
            "vm0/default",
            Duration::from_millis(25),
            "registry failed",
        );
    });

    assert_eq!(events.len(), 1, "events: {events:#?}");
    let event = &events[0];
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "message", "proxy register failed");
    assert_event_field(event, "stage", "proxy_register");
    assert_event_field(event, "elapsed_ms", "25");
    assert_event_field(event, "success", "false");
    assert_event_field(event, "run_id", "00000000-0000-0000-0000-000000000000");
    assert_event_field(event, "sandbox_id", "00000000-0000-0000-0000-000000000000");
    assert_event_field(event, "profile", "vm0/default");
    assert_event_field(event, "error", "registry failed");
}

#[tokio::test]
async fn proxy_registration_accepts_canonical_targets() {
    let canonical_dir = tempfile::tempdir().unwrap();
    let canonical_config = test_executor_config(canonical_dir.path()).await;
    let mut canonical_context = minimal_context();
    let canonical_routing_variables =
        HashMap::from([("ZENDESK_SUBDOMAIN".to_string(), "xn--mnich-kva".to_string())]);
    canonical_context.firewalls = Some(vec![FirewallEntry::Builtin {
        name: "zendesk".to_string(),
        base_url_vars: Some(canonical_routing_variables.clone()),
        source_id: None,
    }]);
    canonical_context.connector_runtime_targets =
        vec![ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "zendesk".to_string(),
            base_url_vars: Some(canonical_routing_variables),
            source_id: None,
        }];
    canonical_context.vars = Some(HashMap::from([(
        "ZENDESK_SUBDOMAIN".to_string(),
        "münich".to_string(),
    )]));

    let _canonical_session = register_proxy(&canonical_config, &canonical_context, "10.200.0.3")
        .await
        .unwrap();
    let canonical_registry: serde_json::Value = serde_json::from_str(
        &tokio::fs::read_to_string(canonical_dir.path().join("proxy-registry.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    let canonical_sandbox = &canonical_registry["sandboxes"]["10.200.0.3"];
    assert_eq!(
        canonical_sandbox["firewalls"],
        serde_json::json!([{
            "kind": "builtin",
            "name": "zendesk",
            "baseUrlVars": {
                "ZENDESK_SUBDOMAIN": "xn--mnich-kva"
            }
        }])
    );
    assert_eq!(
        canonical_sandbox["connectorRuntimeTargets"],
        serde_json::json!([{
            "kind": "builtin",
            "connectorSlug": "zendesk"
        }])
    );
    assert_eq!(
        canonical_sandbox["connectorRoutingVariables"]["builtin:zendesk"],
        serde_json::json!({"ZENDESK_SUBDOMAIN": "münich"})
    );
}

#[tokio::test]
async fn proxy_registration_attributes_network_logs_before_waiting_for_application() {
    use std::os::unix::fs::PermissionsExt;
    use tokio::io::AsyncReadExt;

    let dir = tempfile::tempdir().unwrap();
    let config = Arc::new(test_executor_config(dir.path()).await);
    let context = minimal_context();
    let run_id = context.run_id;
    let log_path = config.log_paths.network_log(run_id);
    let control_dir = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let listener = tokio::net::UnixListener::bind(control_dir.path().join("control.sock")).unwrap();
    config
        .registry
        .set_control_target_for_test(control_dir.path().to_path_buf(), "generation-1".into());
    let source_ip = "10.200.0.3";
    let registration_config = Arc::clone(&config);
    let registration =
        tokio::spawn(
            async move { register_proxy(&registration_config, &context, source_ip).await },
        );
    let (mut peer, _) = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, listener.accept())
        .await
        .unwrap()
        .unwrap();
    let size = peer.read_u32().await.unwrap();
    let mut bytes = vec![0; size as usize];
    peer.read_exact(&mut bytes).await.unwrap();
    let request: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(request["method"], "registry.apply");

    // Reused sandboxes are already unparked. DNS/kernel producers must retain
    // their real per-run file attribution while this control reply is withheld.
    let row = serde_json::json!({"type": "dns", "host": "during-apply.example", "port": 53});
    let accepted = config
        .network_log_manager
        .append_for_ip(source_ip, row.clone())
        .await;
    drop(peer);
    let session = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, registration)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    session
        .close_for_upload(run_id, &config.network_log_drain)
        .await;
    assert!(
        accepted,
        "receipt wait must not delay network-log attribution"
    );
    let recorded: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(log_path).await.unwrap()).unwrap();
    assert_eq!(recorded, row);
}

#[tokio::test]
async fn execute_job_proxy_register_failure_destroys_fresh_sandbox_before_agent_start() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    tokio::fs::remove_file(dir.path().join("proxy-registry.json"))
        .await
        .unwrap();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(
        error.contains("register sandbox in proxy registry"),
        "got: {error}"
    );
    assert!(outcome.sandbox.is_none());
    assert!(outcome.network_log_session.is_none());
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "agent must not start when proxy registry registration fails"
    );
}
#[tokio::test]
async fn execute_reused_sandbox_proxy_register_failure_returns_sandbox_before_agent_start() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let registry_guard = crate::lock::acquire(dir.path().join("proxy-registry.json.lock"))
        .await
        .unwrap();
    tokio::fs::remove_file(dir.path().join("proxy-registry.json"))
        .await
        .unwrap();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let body = b"reused proxy failure".to_vec();
    let mut server =
        RawHttpTestServer::spawn(vec![RawHttpAction::Respond(http_response("200 OK", &body))])
            .await;
    let archive_url = format!("{}/reused-proxy-failure.tar.gz", server.url());
    let mut ctx = minimal_context();
    let mut storage = api_storage("reused-proxy-failure", "/data", "v1", &archive_url);
    storage.archive_size = Some(body.len() as u64);
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![storage],
        artifacts: Vec::new(),
    });
    let storage_lock_path = config.home.storage_lock("reused-proxy-failure", "v1");
    let prev_storage = crate::storage_fingerprints::StorageFingerprints::default();

    let task = tokio::spawn(async move {
        let mut telemetry = test_telemetry(&config, &ctx);
        let outcome = execute_reused_sandbox(
            ReusedSandboxRun {
                sandbox_id: sandbox.id().parse().unwrap(),
                factory: &MockSandboxFactory::new(),
                params: &default_params(),
                sandbox,
                source_ip,
                workspace_image: None,
                kind: crate::idle_pool::IdleSandboxKind::Exact,
            },
            &ctx,
            &config,
            RunStart {
                restore_guest_state: true,
                reuse_result: crate::types::SandboxReuseResult::Reused,
                workspace_reuse_result: crate::types::WorkspaceReuseResult::SandboxReused,
                prev_storage: Some(&prev_storage),
            },
            &mut telemetry,
            PreparedRunInputs::new(
                RunControls::new(tokio_util::sync::CancellationToken::new(), None),
                prepare_run_payload_for_run(&ctx).unwrap(),
            ),
        )
        .await;
        (outcome, telemetry)
    });

    let request = server
        .next_request("archive request while proxy registration is blocked")
        .await;
    assert!(request.starts_with("GET /reused-proxy-failure.tar.gz HTTP/1.1\r\n"));
    assert!(!request.to_ascii_lowercase().contains("\r\nrange:"));
    assert!(
        !task.is_finished(),
        "proxy lock should keep registration from completing"
    );
    drop(registry_guard);

    let (outcome, telemetry) = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, task)
        .await
        .expect("proxy failure should drain prepared storage")
        .expect("reused execution task should not panic");

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(
        error.contains("register sandbox in proxy registry"),
        "got: {error}"
    );
    assert!(outcome.sandbox.is_some());
    assert!(outcome.network_log_session.is_none());
    server.assert_finished().await;
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "reused sandbox must not start an agent when proxy registration fails"
    );
    assert_telemetry_action(
        &telemetry,
        "storage_cache_fresh_delivery_cancelled",
        true,
        None,
    );
    assert_telemetry_action(
        &telemetry,
        "storage_cache_fresh_delivery_drained",
        true,
        None,
    );
    assert!(matches!(
        crate::lock::try_acquire_or_busy(storage_lock_path)
            .await
            .unwrap(),
        crate::lock::TryLock::Acquired(_)
    ));
}

#[tokio::test]
async fn execute_inner_proxy_unregister_failure_marks_successful_run_failed() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_copy_file_result(Ok(b"guest system log\n".to_vec()));
    let copy_gate = MockLifecycleGate::new();
    overrides.set_copy_file_lifecycle_gate(copy_gate.clone());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
    let mut telemetry = test_telemetry(&config, &ctx);

    let run = execute_prepared_sandbox_run(
        PreparedSandboxRun {
            sandbox,
            source_ip,
            network_log_session,
            prepared_guest_runtime: None,
        },
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
            prev_storage: None,
        },
        &mut telemetry,
        PreparedRunInputs::new(
            RunControls::new(tokio_util::sync::CancellationToken::new(), None),
            prepare_run_payload_for_run(&ctx).unwrap(),
        ),
    );
    tokio::pin!(run);

    tokio::select! {
        outcome = &mut run => {
            let _ = outcome;
            panic!("run finished before the diagnostic copy gate");
        }
        entered = copy_gate.wait_entered(1, RUN_IN_SANDBOX_TEST_TIMEOUT) => {
            entered.expect("run should reach the diagnostic copy gate");
        }
    }
    tokio::fs::remove_file(dir.path().join("proxy-registry.json"))
        .await
        .unwrap();
    overrides.clear_copy_file_lifecycle_gate();
    copy_gate.release_many(overrides.copy_file_calls().len());

    let outcome = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, &mut run)
        .await
        .expect("post-gate proxy cleanup and finalization should complete");

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(
        error.contains("post-job proxy cleanup failed"),
        "got: {error}"
    );
    assert!(
        error.contains("unregister sandbox from proxy registry"),
        "got: {error}"
    );
    assert!(outcome.sandbox.is_some());
    assert!(outcome.network_log_session.is_some());
    assert!(outcome.discovered_cli_agent_session_id.is_none());
    assert_eq!(
        outcome.sandbox_reuse_disposition,
        SandboxReuseDisposition::Ineligible(SandboxReuseRejection::PostJobCleanupFailure),
    );
}
