//! Process-env config construction loads and removes the private user-env file.

use guest_agent_tests as common;

#[test]
fn process_env_config_loads_user_env_once() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    std::fs::create_dir_all(&user_env_dir).unwrap();
    std::fs::write(
        &user_env_path,
        r#"{"OPENAI_MODEL":"gpt-process-env","HOME":"/home/from-user-env"}"#,
    )
    .unwrap();

    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, "guest-config-process-env");
        std::env::set_var("HOME", "/home/from-process-env");
        std::env::set_var(
            guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
            &user_env_path,
        );
        std::env::set_var(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            &runtime_dir,
        );
    }

    let missing_payload_error = match guest_agent::env::GuestConfig::from_process_env() {
        Ok(_) => panic!("missing run payload file should fail fast"),
        Err(error) => error,
    };
    assert!(
        missing_payload_error.contains(guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV),
        "error should identify {}, got: {missing_payload_error}",
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV
    );
    assert!(
        user_env_path.exists(),
        "missing run payload should fail before consuming user env"
    );

    unsafe {
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "process env prompt".to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )
        .unwrap();
    }

    let config = guest_agent::env::GuestConfig::from_process_env().unwrap();

    assert_eq!(config.user_env["OPENAI_MODEL"], "gpt-process-env");
    assert_eq!(config.home_dir, "/home/from-user-env");
    assert!(!user_env_path.exists());
    assert!(!user_env_dir.exists());
}
