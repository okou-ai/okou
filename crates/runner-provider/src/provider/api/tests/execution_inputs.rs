use super::*;

mod raw_json;

#[test]
fn dual_publication_uses_explicit_startup_inputs() {
    let mut body: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
    // A preceding API sends both fields. Only startupInputs contributes to the plan.
    body["contentBundles"] = serde_json::json!({"format":"tar-gzip-v1","skills":[]});
    body["storageManifest"] = serde_json::json!({"storageMounts":[]});
    let context = decode_execution_publication(body.to_string().as_bytes()).unwrap();
    let manifest = context.storage_manifest.unwrap();
    assert_eq!(manifest.storages.len(), 2);
    assert_eq!(manifest.artifacts[0].vas_storage_id, "fixture-storage-id");
}

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
    assert_eq!(context.storage_manifest.as_ref().unwrap().storages.len(), 2);
    let continuation = context
        .session_continuation
        .as_ref()
        .expect("complete API publications include session continuation intent");
    assert!(!continuation.continue_native);
    assert!(continuation.expected_source_run_id.is_none());
    assert!(continuation.recovery_prompt.is_none());
    assert!(context.local_resume_session_id.is_none());
    assert_eq!(
        context.environment.as_ref().unwrap()["FIXTURE_MODEL"],
        "fixture-model"
    );
    assert_eq!(
        context.platform_environment["OKOU_CHAT_THREAD_ID"],
        "fixture-thread-id"
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
        "memory-archive",
    ] {
        let mut body: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
        match kind {
            "missing" => {
                body.as_object_mut().unwrap().remove("startupInputs");
            }
            "format" => {
                body["startupInputs"]["contentBundles"]["format"] = serde_json::json!("invalid")
            }
            "null" => body["startupInputs"]["contentBundles"]["instructions"] = Value::Null,
            "hash" => {
                body["startupInputs"]["contentBundles"]["instructions"]["sha256"] =
                    serde_json::json!("invalid")
            }
            "size" => {
                body["startupInputs"]["contentBundles"]["instructions"]["archiveBytes"] =
                    serde_json::json!(32 * 1024 * 1024 + 1)
            }
            "url" => {
                body["startupInputs"]["contentBundles"]["instructions"]["downloadUrl"] = serde_json::json!(
                    "https://user:secret-fixture@storage.fixture.invalid/private?signature=secret-fixture"
                )
            }
            "mount" => {
                body["startupInputs"]["contentBundles"]["skills"][0]["name"] =
                    serde_json::json!("bad/name")
            }
            "memory-archive" => {
                body["startupInputs"]["memory"]
                    .as_object_mut()
                    .unwrap()
                    .remove("archiveUrl");
            }
            "duplicate" => {
                let duplicate = body["startupInputs"]["contentBundles"]["skills"][0].clone();
                body["startupInputs"]["contentBundles"]["skills"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            _ => panic!("unexpected invalid bundle case {kind}"),
        }
        let error = decode_execution_publication(&serde_json::to_vec(&body).unwrap()).unwrap_err();
        assert!(!error.contains("secret-fixture"));
    }
}

#[test]
fn publication_binds_disjoint_startup_mounts_to_the_admitted_framework() {
    use super::template_guidance::template;
    use guest_contracts::agent_instructions::instruction_paths;
    use std::path::Path;

    let claude_memory = "/home/user/.claude/projects/-home-user-workspace/memory";
    for (framework, skill_root, memory_path) in [
        ("claude-code", "/home/user/.claude/skills", claude_memory),
        (
            "codex",
            "/home/user/.codex/skills",
            "/home/user/.codex/memories",
        ),
        (
            "pi",
            "/home/user/.pi/agent/skills",
            "/home/user/.pi/agent/memory",
        ),
        ("antigravity", "/home/user/.claude/skills", claude_memory),
    ] {
        let skill_path = format!("{skill_root}/fixture-skill");
        let mut body: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
        body["cliAgentType"] = serde_json::json!(framework);
        let bundles = &mut body["startupInputs"]["contentBundles"];
        bundles["templates"] =
            serde_json::json!([template("user-template"), template("presentation-template")]);
        let skills = bundles["skills"].as_array_mut().unwrap();
        let mut other_skill = skills[0].clone();
        other_skill["name"] = serde_json::json!("fixture-skill-extra");
        skills.push(other_skill);
        body["startupInputs"]["memory"] = serde_json::json!({
            "storageId": "member-memory-id",
            "versionId": "accepted-memory-version",
            "missingRootPolicy": "preserveParentVersion",
            "empty": true,
        });
        let context = decode_execution_publication(&serde_json::to_vec(&body).unwrap()).unwrap();
        let manifest = context.storage_manifest.unwrap();
        assert!(
            manifest
                .storages
                .iter()
                .any(|entry| entry.mount_path == skill_path)
        );
        let [memory] = manifest.artifacts.as_slice() else {
            panic!("expected one Member Memory writeback input for {framework}");
        };
        assert_eq!(memory.mount_path, memory_path);
        assert_eq!(memory.vas_storage_id, "member-memory-id");
        assert_eq!(memory.vas_version_id, "accepted-memory-version");
        assert_eq!(memory.empty, Some(true));
        assert_eq!(
            memory.missing_root_policy,
            Some(
                api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy::PreserveParentVersion,
            ),
        );
        assert_eq!(
            context.instruction_file.unwrap().storage_mount,
            format!("/home/user/.vm0/agent-instructions/{framework}"),
        );

        let final_instructions = instruction_paths(Path::new("/home/user"), framework)
            .unwrap()
            .target;
        let mounts: Vec<_> = manifest
            .storages
            .iter()
            .map(|entry| Path::new(&entry.mount_path))
            .chain(std::iter::once(Path::new(&memory.mount_path)))
            .collect();
        assert_eq!(mounts.len(), 6);
        for (index, mount) in mounts.iter().enumerate() {
            assert!(!final_instructions.starts_with(mount));
            for other in &mounts[index + 1..] {
                assert!(
                    !mount.starts_with(other) && !other.starts_with(mount),
                    "{framework} has overlapping startup mounts {mount:?} and {other:?}"
                );
            }
        }
    }
}

#[test]
fn publication_normalizes_framework_paths_and_ignores_forged_application_metadata() {
    let mut body: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
    body["instructionFile"] = serde_json::json!({"storageMount":"/home/user/.ssh"});
    body["localResumeSessionId"] = serde_json::json!("forged-local-session");
    body["localSecretEnvKeys"] = serde_json::json!(["FORGED_SECRET"]);
    body["startupInputs"]["contentBundles"]["skills"][0]["name"] = serde_json::json!("x");
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
