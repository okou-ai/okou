use runner_types::storage_manifest::workflow_mount_path;

#[test]
fn skill_mounts_accept_single_character_names_for_every_framework() {
    for root in [
        "/home/user/.claude",
        "/home/user/.codex",
        "/home/user/.pi/agent",
    ] {
        let skill_prefix = format!("{root}/skills/");
        for name in [
            "x".to_string(),
            "workflow-setup".to_string(),
            "x".repeat(64),
        ] {
            let legacy_path = format!("/previous/framework/skills/{name}");
            assert_eq!(
                workflow_mount_path(legacy_path, &skill_prefix).unwrap(),
                format!("{skill_prefix}{name}"),
            );
        }
    }
}

#[test]
fn skill_mounts_require_a_valid_name() {
    for path in [
        "name-without-a-path".to_string(),
        "/home/user/.codex/skills/..".to_string(),
        "/home/user/.codex/skills/".to_string(),
        "/home/user/.codex/skills/-x".to_string(),
        "/home/user/.codex/skills/x-".to_string(),
        "/home/user/.codex/skills/x_y".to_string(),
        format!("/home/user/.codex/skills/{}", "x".repeat(65)),
    ] {
        assert!(
            workflow_mount_path(path.clone(), "/home/user/.codex/skills/").is_err(),
            "{path}"
        );
    }
}
