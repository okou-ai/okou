#![cfg(feature = "test-support")]

use cli_test_support::mock_build::build_and_locate_mock_package_in_workspace;
use std::fs;
use std::process::Command;

#[test]
fn mock_build_preserves_target_profile_and_session() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let workspace = temp.path();
    let manifest = workspace.join("Cargo.toml");
    fs::write(
        &manifest,
        r#"
[workspace]

[package]
name = "mock-package"
version = "0.0.0"
edition = "2024"

[profile.local]
inherits = "dev"
debug-assertions = false
"#,
    )?;
    fs::create_dir(workspace.join("src"))?;
    fs::write(
        workspace.join("src/main.rs"),
        "fn main() { println!(\"{}\", cfg!(debug_assertions)); }\n",
    )?;
    let target_dir = workspace.join("custom-target");
    fs::create_dir(&target_dir)?;

    for (profile, debug_assertions) in [("debug", true), ("release", false), ("local", false)] {
        let profile_dir = target_dir.join(profile);
        let test_name = "test-client-0123456789abcdef";
        let test_exe = profile_dir
            .join("build/test-client/0123456789abcdef/out")
            .join(test_name);
        let session = "layout-fixture-session";
        let mock = build_and_locate_mock_package_in_workspace(
            workspace,
            &test_exe,
            "mock-package",
            "mock-package",
            Some(session),
        )?;
        assert_eq!(mock, profile_dir.join("mock-package"));
        let output = Command::new(&mock).output()?;
        assert!(output.status.success());
        assert_eq!(output.stdout, format!("{debug_assertions}\n").as_bytes());
        assert_eq!(
            fs::read_to_string(
                target_dir.join(format!(".vm0-mock-package-{profile}.build-session"))
            )?,
            session
        );

        // Calls in one Cargo/nextest session share the same mock. With the
        // manifest hidden, an unexpected rebuild cannot succeed.
        let hidden_manifest = workspace.join("Cargo.toml.hidden");
        fs::rename(&manifest, &hidden_manifest)?;
        let reuse = build_and_locate_mock_package_in_workspace(
            workspace,
            &test_exe,
            "mock-package",
            "mock-package",
            Some(session),
        );
        fs::rename(&hidden_manifest, &manifest)?;
        assert_eq!(reuse?, mock);
    }
    Ok(())
}
