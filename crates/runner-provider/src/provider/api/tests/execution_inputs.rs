use super::*;

#[test]
fn complete_publication_preserves_canonical_execution_inputs() {
    let run_id: RunId = RUNNER_EXECUTION_CONTEXT_FIXTURE_RUN_ID.parse().unwrap();
    let context =
        decode_execution_publication(RUNNER_EXECUTION_CONTEXT_FIXTURE.as_bytes()).unwrap();
    assert_eq!(context.run_id, run_id);
    assert_eq!(context.prompt, "Inspect the fixture repository");
    let storages = &context.storage_manifest.as_ref().unwrap().storages;
    let instructions = storages
        .iter()
        .find(|entry| entry.vas_storage_name == "instruction")
        .unwrap();
    assert_eq!(instructions.vas_version_id, "a".repeat(64));
    assert_eq!(instructions.archive_size, Some(128));
    assert_eq!(
        context.instruction_file.as_ref().unwrap().storage_mount,
        instructions.mount_path
    );
    let skill = storages
        .iter()
        .find(|entry| entry.vas_storage_name == "workflow")
        .unwrap();
    assert_eq!(skill.vas_version_id, "b".repeat(64));
    assert_eq!(skill.archive_size, Some(256));
    assert_eq!(skill.mount_path, "/home/user/.codex/skills/fixture-skill");
    assert_eq!(
        context.append_system_prompt.as_deref(),
        Some("Use the shared contract fixture")
    );
    assert_eq!(
        context.vars.as_ref().unwrap()["FIXTURE_REGION"],
        "test-region"
    );
    assert_eq!(context.storage_manifest.as_ref().unwrap().storages.len(), 3);
    let native = context
        .native_continuation
        .as_ref()
        .expect("complete API publications include native continuation intent");
    assert!(native.session_id.is_none());
    assert!(native.generation_run_id.is_none());
    assert!(native.recovery_prompt.is_none());
    assert!(context.cli_agent_session_id().is_none());
    assert_eq!(
        context.environment.as_ref().unwrap()["FIXTURE_MODEL"],
        "fixture-model"
    );
    assert_eq!(
        context.platform_environment["OKOU_AGENT_ID"],
        "fixture-agent-id"
    );
    assert_eq!(
        context.model_usage_provider.as_deref(),
        Some("fixture-model")
    );
    assert_eq!(
        context.model_usage_long_context_min_total_input_tokens,
        Some(272_001)
    );
    assert_eq!(
        context.secret_values.as_deref(),
        Some(["fixture-secret-value-not-real".to_string()].as_slice())
    );
    assert!(context.local_secret_env_keys.is_none());
    assert_eq!(
        context.secret_connector_metadata_map.as_ref().unwrap()["FIXTURE_API_KEY"]
            .source_user_id
            .as_deref(),
        Some("fixture-user-id")
    );
    assert_eq!(context.capture_network_bodies, Some(true));
    assert_eq!(context.user_timezone.as_deref(), Some("UTC"));
    assert_eq!(
        context.network_policies.as_ref().unwrap()["model-provider:fixture"].unknown_policy,
        "deny"
    );
    assert_eq!(
        context.billable_firewalls,
        ["model-provider:fixture".to_string()]
    );
    assert_eq!(
        context.codex_runtime_config.as_ref().unwrap().provider_id,
        "fixture_provider"
    );
}

#[test]
fn complete_publication_rejects_invalid_bundles_and_conflicting_mounts() {
    for kind in [
        "missing",
        "format",
        "null",
        "hash",
        "size",
        "url",
        "mount",
        "duplicate",
        "storage-conflict",
        "instruction-conflict",
    ] {
        let mut body: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
        match kind {
            "missing" => {
                body.as_object_mut().unwrap().remove("contentBundles");
            }
            "format" => body["contentBundles"]["format"] = serde_json::json!("invalid"),
            "null" => body["contentBundles"]["instructions"] = Value::Null,
            "hash" => {
                body["contentBundles"]["instructions"]["sha256"] = serde_json::json!("invalid")
            }
            "size" => {
                body["contentBundles"]["instructions"]["archiveBytes"] =
                    serde_json::json!(32 * 1024 * 1024 + 1)
            }
            "url" => {
                body["contentBundles"]["instructions"]["downloadUrl"] = serde_json::json!(
                    "https://user:secret-fixture@storage.fixture.invalid/private?signature=secret-fixture"
                )
            }
            "mount" => {
                body["contentBundles"]["skills"][0]["mountPath"] =
                    serde_json::json!("/home/user/.codex")
            }
            "duplicate" => {
                let duplicate = body["contentBundles"]["skills"][0].clone();
                body["contentBundles"]["skills"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            _ => {
                let mount = if kind == "instruction-conflict" {
                    "/home/user/.vm0/agent-instructions/codex"
                } else {
                    "/home/user/.codex/skills/fixture-skill"
                };
                let mut conflict = body["storageManifest"]["storageMounts"][0].clone();
                conflict["mountPath"] = serde_json::json!(mount);
                body["storageManifest"]["storageMounts"]
                    .as_array_mut()
                    .unwrap()
                    .push(conflict);
            }
        }
        let error = decode_execution_publication(&serde_json::to_vec(&body).unwrap()).unwrap_err();
        assert!(!error.contains("secret-fixture"));
    }
}

#[test]
fn publication_normalizes_framework_paths_and_ignores_forged_application_metadata() {
    let mut body: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
    body["instructionFile"] = serde_json::json!({"storageMount":"/home/user/.ssh"});
    body["localResumeSessionId"] = serde_json::json!("forged-local-session");
    body["localSecretEnvKeys"] = serde_json::json!(["FORGED_SECRET"]);
    body["contentBundles"]["skills"][0]["mountPath"] =
        serde_json::json!("/home/user/.codex/skills/x");
    let context = decode_execution_publication(&serde_json::to_vec(&body).unwrap()).unwrap();
    assert_eq!(
        context.instruction_file.unwrap().storage_mount,
        "/home/user/.vm0/agent-instructions/codex"
    );
    assert!(context.local_resume_session_id.is_none());
    assert!(context.local_secret_env_keys.is_none());
    let skill = context
        .storage_manifest
        .unwrap()
        .storages
        .into_iter()
        .find(|e| e.mount_path == "/home/user/.codex/skills/x")
        .unwrap();
    assert_eq!(skill.vas_version_id, "b".repeat(64));
    assert_eq!(skill.archive_size, Some(256));
}

#[test]
fn malformed_publication_diagnostics_do_not_expose_dynamic_keys_or_secret_values() {
    for malformed in [
        serde_json::json!({"firewalls":[{"kind":"private-secret-value"}]}),
        serde_json::json!({"networkPolicies":{"private-key":{"unknownPolicy":42}}}),
        serde_json::json!({"sandboxToken":{"private-token":true}}),
    ] {
        let mut body: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
        for (key, value) in malformed.as_object().unwrap() {
            body[key] = value.clone();
        }
        let error = decode_execution_publication(&serde_json::to_vec(&body).unwrap()).unwrap_err();
        assert_eq!(error, "Invalid execution context");
    }
}
