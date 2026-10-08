//! Integration coverage for test-runner-session-scoped guest mock reuse.

mod common;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

const WORKSPACE_WITH_CONTRACT_ONE: &str = r#"
[workspace]
resolver = "3"
members = ["mock", "contract-one", "contract-two"]

[workspace.dependencies]
contract = { package = "contract-one", path = "contract-one" }
"#;

const WORKSPACE_WITH_CONTRACT_TWO: &str = r#"
[workspace]
resolver = "3"
members = ["mock", "contract-one", "contract-two"]

[workspace.dependencies]
contract = { package = "contract-two", path = "contract-two" }
"#;

const MOCK_MANIFEST: &str = r#"
[package]
name = "mock-package"
version = "0.1.0"
edition = "2024"

[dependencies]
contract.workspace = true
"#;

const MOCK_SOURCE: &str = r#"
fn main() {
    println!("{}", contract::value());
}
"#;

const CONTRACT_ONE_MANIFEST: &str = r#"
[package]
name = "contract-one"
version = "0.1.0"
edition = "2024"
"#;

const CONTRACT_TWO_MANIFEST: &str = r#"
[package]
name = "contract-two"
version = "0.1.0"
edition = "2024"
"#;

#[test]
fn mock_build_session_revalidates_dependency_inputs() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let workspace = temp.path();
    let mock_dir = workspace.join("mock");
    let contract_one_dir = workspace.join("contract-one");
    let contract_two_dir = workspace.join("contract-two");
    fs::create_dir_all(mock_dir.join("src"))?;
    fs::create_dir_all(contract_one_dir.join("src"))?;
    fs::create_dir_all(contract_two_dir.join("src"))?;

    let workspace_manifest = workspace.join("Cargo.toml");
    let mock_manifest = mock_dir.join("Cargo.toml");
    let mock_source = mock_dir.join("src/main.rs");
    fs::write(&workspace_manifest, WORKSPACE_WITH_CONTRACT_ONE)?;
    fs::write(&mock_manifest, MOCK_MANIFEST)?;
    fs::write(&mock_source, MOCK_SOURCE)?;
    fs::write(contract_one_dir.join("Cargo.toml"), CONTRACT_ONE_MANIFEST)?;
    fs::write(
        contract_one_dir.join("src/lib.rs"),
        "pub fn value() -> &'static str { \"one\" }\n",
    )?;
    fs::write(contract_two_dir.join("Cargo.toml"), CONTRACT_TWO_MANIFEST)?;
    fs::write(
        contract_two_dir.join("src/lib.rs"),
        "pub fn value() -> &'static str { \"two\" }\n",
    )?;

    let original_mock_manifest = fs::read(&mock_manifest)?;
    let original_mock_source = fs::read(&mock_source)?;
    let target_profile_dir = workspace.join("target/debug");
    fs::create_dir(workspace.join("target"))?;

    #[cfg(target_os = "linux")]
    let session = common::test_runner_build_session_id()
        .ok_or_else(|| io::Error::other("expected a verified Cargo or nextest parent"))?;
    #[cfg(not(target_os = "linux"))]
    let session = String::from("session-one");
    let mock = build_mock(workspace, &target_profile_dir, Some(&session))?;
    assert_eq!(run_mock(&mock)?, "one");
    let session_marker = workspace.join("target/.vm0-mock-package-debug.build-session");
    assert_eq!(fs::read_to_string(&session_marker)?, session);

    // Hide the manifest so any unexpected second Cargo invocation fails.
    let hidden_workspace_manifest = workspace.join("Cargo.toml.hidden");
    fs::rename(&workspace_manifest, &hidden_workspace_manifest)?;
    #[cfg(target_os = "linux")]
    let reuse_session = common::test_runner_build_session_id();
    #[cfg(not(target_os = "linux"))]
    let reuse_session = Some(session);
    let reuse_result = build_mock(workspace, &target_profile_dir, reuse_session.as_deref());
    fs::rename(&hidden_workspace_manifest, &workspace_manifest)?;
    let reused = reuse_result?;
    assert_eq!(reused, mock);

    fs::write(
        contract_one_dir.join("src/lib.rs"),
        "pub fn value() -> &'static str { \"one-updated\" }\n",
    )?;
    let rebuilt = build_mock(workspace, &target_profile_dir, Some("session-two"))?;
    assert_eq!(run_mock(&rebuilt)?, "one-updated");

    fs::write(&workspace_manifest, WORKSPACE_WITH_CONTRACT_TWO)?;
    let remapped = build_mock(workspace, &target_profile_dir, Some("session-three"))?;
    assert_eq!(run_mock(&remapped)?, "two");

    let lock_path = workspace.join("Cargo.lock");
    let valid_lock = fs::read_to_string(&lock_path)?;
    let valid_contract = "name = \"contract-two\"\nversion = \"0.1.0\"";
    let invalid_contract = "name = \"contract-two\"\nversion = \"9.9.9\"";
    let invalid_lock = valid_lock.replacen(valid_contract, invalid_contract, 1);
    assert_ne!(
        invalid_lock, valid_lock,
        "lockfile fixture should be changed"
    );
    fs::write(&lock_path, invalid_lock)?;
    let lock_revalidated = build_mock(workspace, &target_profile_dir, Some("session-four"))?;
    assert_eq!(run_mock(&lock_revalidated)?, "two");
    let repaired_lock = fs::read_to_string(&lock_path)?;
    assert!(repaired_lock.contains(valid_contract));
    assert!(!repaired_lock.contains(invalid_contract));

    fs::write(
        contract_two_dir.join("src/lib.rs"),
        "pub fn value() -> &'static str { \"two-updated\" }\n",
    )?;
    let uncached = build_mock(workspace, &target_profile_dir, None)?;
    assert_eq!(run_mock(&uncached)?, "two-updated");
    assert!(!session_marker.exists());

    assert_eq!(fs::read(&mock_manifest)?, original_mock_manifest);
    assert_eq!(fs::read(&mock_source)?, original_mock_source);
    Ok(())
}

fn build_mock(
    workspace: &Path,
    target_profile_dir: &Path,
    build_session: Option<&str>,
) -> io::Result<PathBuf> {
    common::build_and_locate_mock_package_in_workspace(
        workspace,
        target_profile_dir,
        "mock-package",
        "mock-package",
        build_session,
    )
    .map_err(io::Error::other)
}

fn run_mock(mock: &Path) -> io::Result<String> {
    let output = Command::new(mock).output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "mock exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    String::from_utf8(output.stdout)
        .map(|stdout| stdout.trim().to_owned())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}
