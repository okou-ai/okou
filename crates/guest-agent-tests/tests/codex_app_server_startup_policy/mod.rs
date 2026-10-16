use shell_quote::quote_shell_arg;
use std::path::{Path, PathBuf};

const CODEX_FIXED_STARTUP_CONFIGS: [&str; 5] = [
    "analytics.enabled=false",
    "features.plugins=false",
    "features.apps=false",
    "features.goals=false",
    "features.image_generation=false",
];
const CODEX_FAST_MODE_STARTUP_CONFIGS: [&str; 2] =
    ["features.fast_mode=true", r#"service_tier="fast""#];

pub(crate) fn recording_codex(
    root: &Path,
    mock: &Path,
    argv_path: &Path,
) -> Result<PathBuf, std::io::Error> {
    use std::os::unix::fs::PermissionsExt as _;

    let path = root.join("recording-codex");
    std::fs::write(
        &path,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > {}\nexec {} \"$@\"\n",
            quote_shell_arg(&argv_path.to_string_lossy()),
            quote_shell_arg(&mock.to_string_lossy()),
        ),
    )?;
    let mut permissions = std::fs::metadata(&path)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&path, permissions)?;
    Ok(path)
}

pub(crate) fn assert_startup_policy(
    argv_path: &Path,
    expect_fast_mode: bool,
) -> Result<(), std::io::Error> {
    let args = std::fs::read_to_string(argv_path)?
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let app_server_index = args
        .iter()
        .position(|arg| arg == "app-server")
        .ok_or_else(|| std::io::Error::other("Codex argv omitted app-server subcommand"))?;

    for config in CODEX_FIXED_STARTUP_CONFIGS {
        assert_config_count_and_order(&args, app_server_index, config, 1);
    }
    for config in CODEX_FAST_MODE_STARTUP_CONFIGS {
        let expected_count = usize::from(expect_fast_mode);
        assert_config_count_and_order(&args, app_server_index, config, expected_count);
    }
    Ok(())
}

fn assert_config_count_and_order(
    args: &[String],
    app_server_index: usize,
    config: &str,
    expected_count: usize,
) {
    let indexes = args
        .windows(2)
        .enumerate()
        .filter_map(|(index, window)| {
            matches!(window, [flag, value] if flag == "-c" && value == config).then_some(index)
        })
        .collect::<Vec<_>>();
    assert_eq!(
        indexes.len(),
        expected_count,
        "unexpected count for Codex app-server config {config:?}: {args:?}"
    );
    assert!(
        indexes.iter().all(|index| *index < app_server_index),
        "Codex app-server config {config:?} must precede the subcommand: {args:?}"
    );
}
