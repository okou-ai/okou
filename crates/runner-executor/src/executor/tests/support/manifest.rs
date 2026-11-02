use runner_types::storage_manifest::{ArtifactEntry, StorageEntry};

pub(in crate::executor::tests) fn workflow_context(
    hash: &str,
    bytes: u64,
    mount: &str,
    suffix: &str,
) -> runner_types::types::ExecutionContext {
    let mut context = super::minimal_context();
    let mut storage = api_storage(
        "workflow",
        mount,
        hash,
        &format!("https://unreachable.invalid/{suffix}"),
    );
    storage.archive_size = Some(bytes);
    context.storage_manifest = Some(runner_types::storage_manifest::StorageManifest {
        storages: vec![storage],
        artifacts: Vec::new(),
    });
    context
}

pub(in crate::executor::tests) fn instruction_context(
    hash: &str,
    bytes: u64,
    framework: &str,
    suffix: &str,
) -> runner_types::types::ExecutionContext {
    let paths = guest_contracts::agent_instructions::instruction_paths(
        std::path::Path::new("/home/user"),
        framework,
    )
    .unwrap();
    let mount = paths.staging.to_str().unwrap();
    let mut context = workflow_context(hash, bytes, mount, suffix);
    context.cli_agent_type = framework.into();
    if framework == "pi" {
        context.pi_session_id = Some("22222222-2222-4222-8222-222222222222".into());
        context.pi_launch_config = Some(serde_json::json!({"schemaVersion": 2}));
        context.pi_model_config = Some(serde_json::json!({
            "schemaVersion": 5, "dialect": "openai-completions", "transport": "sse",
            "provider": "openrouter", "baseUrl": "https://openrouter.ai/api/v1",
            "model": "moonshotai/kimi-k2", "thinkingLevel": "low",
            "credentialBindings": [{"kind": "api-key", "environment": "OPENAI_API_KEY", "secretName": "OPENROUTER_API_KEY"}],
        }));
    }
    let entry = &mut context.storage_manifest.as_mut().unwrap().storages[0];
    entry.name = "instruction".into();
    entry.vas_storage_name = "instruction".into();
    context.instruction_file = Some(runner_types::storage_manifest::InstructionFile {
        storage_mount: mount.into(),
    });
    context
}

pub(in crate::executor::tests) fn api_storage(
    name: &str,
    mount_path: &str,
    version: &str,
    archive_url: &str,
) -> StorageEntry {
    StorageEntry {
        name: name.into(),
        mount_path: mount_path.into(),
        archive_url: archive_url.into(),
        vas_storage_name: name.into(),
        vas_version_id: version.into(),
        archive_size: None,
    }
}

pub(in crate::executor::tests) fn api_artifact(
    name: &str,
    mount_path: &str,
    storage_id: &str,
    version: &str,
    archive_url: &str,
) -> ArtifactEntry {
    ArtifactEntry {
        mount_path: mount_path.into(),
        archive_url: Some(archive_url.into()),
        vas_storage_name: name.into(),
        vas_storage_id: storage_id.into(),
        vas_version_id: version.into(),
        empty: None,
        missing_root_policy: None,
        archive_size: None,
    }
}
