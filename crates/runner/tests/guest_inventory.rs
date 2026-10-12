use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GuestBinary {
    package: String,
    binary: String,
    path_env: String,
    bundled_env: String,
    destination: String,
}

#[derive(Deserialize)]
struct CargoMetadata {
    packages: Vec<CargoPackage>,
}

#[derive(Deserialize)]
struct CargoPackage {
    name: String,
    dependencies: Vec<CargoDependency>,
    targets: Vec<CargoTarget>,
}

#[derive(Deserialize)]
struct CargoDependency {
    name: String,
    kind: Option<String>,
    path: Option<PathBuf>,
}

#[derive(Deserialize)]
struct CargoTarget {
    name: String,
    kind: Vec<String>,
}

#[derive(Deserialize)]
struct ReleasePleaseConfig {
    packages: BTreeMap<String, Value>,
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn assert_unique<'a>(label: &str, values: impl IntoIterator<Item = &'a str>) {
    let mut unique = BTreeSet::new();
    for value in values {
        assert!(unique.insert(value), "duplicate {label}: {value}");
    }
}

fn expected_runtime_destinations() -> BTreeMap<&'static str, &'static str> {
    use guest_contracts::guest_binary;

    BTreeMap::from([
        ("guest-agent", guest_binary::AGENT_PATH),
        ("guest-storage-apply", guest_binary::STORAGE_APPLY_PATH),
        ("guest-init", guest_binary::INIT_PATH),
        ("guest-state-restore", guest_binary::STATE_RESTORE_PATH),
        ("guest-write-file", guest_binary::WRITE_FILE_PATH),
        (
            "guest-home-mount",
            guest_contracts::home_mount::HOME_MOUNT_PATH,
        ),
        ("guest-tool-exec", guest_binary::TOOL_EXEC_PATH),
        ("guest-task-exec", guest_binary::TASK_EXEC_PATH),
        ("runner-rpc-client", guest_binary::RUNNER_RPC_CLIENT_PATH),
        ("claude-mock", guest_binary::CLAUDE_MOCK_PATH),
        ("codex-mock", guest_binary::CODEX_MOCK_PATH),
    ])
}

#[test]
fn delivered_guests_match_cargo_and_release_contracts() {
    let root = repo_root();
    let inventory: Vec<GuestBinary> = serde_json::from_slice(
        &std::fs::read(root.join("crates/runner/guest-binaries.json")).unwrap(),
    )
    .unwrap();
    assert!(!inventory.is_empty());

    assert_unique(
        "guest package",
        inventory.iter().map(|guest| guest.package.as_str()),
    );
    assert_unique(
        "guest binary",
        inventory.iter().map(|guest| guest.binary.as_str()),
    );
    assert_unique(
        "guest path environment key",
        inventory.iter().map(|guest| guest.path_env.as_str()),
    );
    assert_unique(
        "guest bundled environment key",
        inventory.iter().map(|guest| guest.bundled_env.as_str()),
    );
    assert_unique(
        "guest destination",
        inventory.iter().map(|guest| guest.destination.as_str()),
    );
    for guest in &inventory {
        let relative = guest
            .destination
            .strip_prefix('/')
            .unwrap_or_else(|| panic!("guest destination must be absolute: {}", guest.destination));
        assert!(
            !relative.is_empty()
                && !relative
                    .split('/')
                    .any(|component| component.is_empty() || component == "." || component == ".."),
            "guest destination must be a safe non-root path: {}",
            guest.destination
        );
    }

    let inventory_destinations: BTreeMap<_, _> = inventory
        .iter()
        .map(|guest| (guest.binary.as_str(), guest.destination.as_str()))
        .collect();
    assert_eq!(inventory_destinations, expected_runtime_destinations());

    let output = Command::new(env!("CARGO"))
        .args([
            "metadata",
            "--manifest-path",
            "crates/Cargo.toml",
            "--no-deps",
            "--format-version",
            "1",
        ])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "cargo metadata failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let metadata: CargoMetadata = serde_json::from_slice(&output.stdout).unwrap();

    let runner = metadata
        .packages
        .iter()
        .find(|package| package.name == "runner")
        .unwrap();
    let inventory_packages: BTreeSet<_> = inventory
        .iter()
        .map(|guest| guest.package.as_str())
        .collect();
    let runner_guest_dev_dependencies: BTreeSet<_> = runner
        .dependencies
        .iter()
        .filter(|dependency| {
            dependency.kind.as_deref() == Some("dev")
                && dependency.path.is_some()
                && metadata.packages.iter().any(|package| {
                    package.name == dependency.name
                        && package
                            .targets
                            .iter()
                            .any(|target| target.kind.iter().any(|kind| kind == "bin"))
                })
        })
        .map(|dependency| dependency.name.as_str())
        .collect();
    assert_eq!(runner_guest_dev_dependencies, inventory_packages);

    for guest in &inventory {
        let package = metadata
            .packages
            .iter()
            .find(|package| package.name == guest.package)
            .unwrap_or_else(|| panic!("missing workspace guest package: {}", guest.package));
        assert!(
            package.targets.iter().any(|target| {
                target.name == guest.binary && target.kind.iter().any(|kind| kind == "bin")
            }),
            "{} does not expose binary target {}",
            guest.package,
            guest.binary
        );
    }

    let release_config: ReleasePleaseConfig =
        serde_json::from_slice(&std::fs::read(root.join("release-please-config.json")).unwrap())
            .unwrap();
    for guest in &inventory {
        let release_path = format!("crates/{}", guest.package);
        assert!(
            release_config.packages.contains_key(&release_path),
            "release-please does not register {release_path}"
        );
    }
}
