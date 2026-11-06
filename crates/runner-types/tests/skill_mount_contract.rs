use runner_types::storage_manifest::validate_workflow_mount;

#[test]
fn skill_mounts_accept_single_character_names_for_every_framework() {
    for root in [".claude", ".codex", ".pi/agent"] {
        for name in [
            "x".to_string(),
            "workflow-setup".to_string(),
            "x".repeat(64),
        ] {
            let path = format!("/home/user/{root}/skills/{name}");
            assert_eq!(validate_workflow_mount(&path), Ok(()), "{path}");
        }
    }
}

#[test]
fn skill_mounts_keep_directory_and_name_boundaries() {
    for path in [
        "/etc/x".to_string(),
        "/home/user/.codex/skills/../x".to_string(),
        "/home/user/.codex/skills/".to_string(),
        "/home/user/.codex/skills/-x".to_string(),
        "/home/user/.codex/skills/x-".to_string(),
        "/home/user/.codex/skills/x_y".to_string(),
        format!("/home/user/.codex/skills/{}", "x".repeat(65)),
    ] {
        assert!(validate_workflow_mount(&path).is_err(), "{path}");
    }
}
