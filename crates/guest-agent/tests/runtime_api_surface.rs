use std::fs;
use std::path::Path;

const RUN_SCOPED_ENV_READER_NAMES: &[&str] = &[
    "run_id",
    "api_url",
    "api_token",
    "sandbox_id",
    "sandbox_reuse_result",
    "prompt",
    "append_system_prompt",
    "resume_session_id",
    "api_start_time",
    "secret_values",
    "disallowed_tools",
    "tools",
    "settings",
    "user_env",
    "openai_api_key",
    "openai_model",
    "anthropic_model",
    "chatgpt_account_id",
    "is_codex_oauth_mode",
    "home_dir",
    "artifacts",
];

const RUN_SCOPED_PATH_READER_NAMES: &[&str] = &[
    "runtime_dir",
    "session_id_file",
    "finalization_error_file",
    "final_session_history_identity_file",
    "failure_diagnostic_file",
    "system_log_file",
    "agent_log_file",
    "metrics_log_file",
    "sandbox_ops_file",
    "telemetry_system_log_pos_file",
    "telemetry_metrics_pos_file",
    "telemetry_sandbox_ops_pos_file",
];

#[test]
fn env_and_paths_modules_do_not_reintroduce_run_scoped_facades() -> std::io::Result<()> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let env_rs = read_source(manifest_dir, "src/env.rs")?;
    let paths_rs = read_source(manifest_dir, "src/paths.rs")?;

    assert_no_module_static_state(&env_rs, "src/env.rs");
    assert_no_module_static_state(&paths_rs, "src/paths.rs");

    for name in RUN_SCOPED_ENV_READER_NAMES {
        assert_no_zero_arg_reader(&env_rs, "src/env.rs", name);
    }
    for name in RUN_SCOPED_PATH_READER_NAMES {
        assert_no_zero_arg_reader(&paths_rs, "src/paths.rs", name);
    }

    Ok(())
}

fn read_source(manifest_dir: &Path, relative_path: &str) -> Result<String, std::io::Error> {
    let path = manifest_dir.join(relative_path);
    fs::read_to_string(&path).map_err(|error| {
        std::io::Error::new(error.kind(), format!("read {}: {error}", path.display()))
    })
}

fn assert_no_module_static_state(source: &str, label: &str) {
    assert!(
        !non_comment_lines(source).any(is_static_item),
        "{label} must not reintroduce static module state; use explicit GuestConfig/GuestPaths ownership"
    );
    assert!(
        !non_comment_lines(source).any(|line| line.contains("thread_local!")),
        "{label} must not reintroduce thread-local module state; use explicit GuestConfig/GuestPaths ownership"
    );
}

fn assert_no_zero_arg_reader(source: &str, label: &str, name: &str) {
    let compact_source = non_comment_lines(source)
        .flat_map(str::chars)
        .filter(|c| !c.is_whitespace())
        .collect::<String>();
    let pattern = format!("fn{name}()");
    assert!(
        !compact_source.contains(&pattern),
        "{label} must not expose zero-argument run-scoped reader {name}(); use GuestConfig/GuestPaths"
    );
}

fn non_comment_lines(source: &str) -> impl Iterator<Item = &str> {
    source
        .lines()
        .map(str::trim_start)
        .filter(|line| !line.starts_with("//"))
}

fn is_static_item(line: &str) -> bool {
    let mut tokens = line.split_whitespace();
    match tokens.next() {
        Some("static") => true,
        Some(vis) if vis.starts_with("pub") => matches!(tokens.next(), Some("static")),
        _ => false,
    }
}
