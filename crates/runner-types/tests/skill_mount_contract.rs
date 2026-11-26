use runner_types::storage_manifest::validate_workflow_skill_name;

#[test]
fn accepts_single_character_and_maximum_length_skill_names() {
    for name in [
        "x".to_string(),
        "workflow-setup".to_string(),
        "x".repeat(64),
    ] {
        assert_eq!(validate_workflow_skill_name(&name), Ok(()));
    }
}

#[test]
fn skill_names_are_one_safe_path_component() {
    for name in ["..", "", "-x", "x-", "x_y", "a/b", &"x".repeat(65)] {
        assert!(validate_workflow_skill_name(name).is_err(), "{name}");
    }
}
