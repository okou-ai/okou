// Build scripts are compile-time only — panic/expect/unwrap are appropriate for fatal errors.
#![allow(clippy::panic, clippy::expect_used, clippy::unwrap_used)]

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::{env, fs};

use serde::Deserialize;
use sha2::{Digest, Sha256};

#[path = "src/cli_package.rs"]
mod cli_package;
use cli_package::{CliSessionConstruction, CliVersions, valid_lower_hex};

const GUEST_BINARIES_FILE: &str = "guest-binaries.json";
const MAX_CLI_PACKAGE_SIZE: u64 = 64 * 1024 * 1024;
const MAX_CLI_MANIFEST_SIZE: u64 = 16 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliManifest {
    version: u32,
    package: CliPackage,
    versions: CliVersions,
    session_construction: CliSessionConstruction,
}

#[derive(Deserialize)]
struct CliPackage {
    path: String,
    sha256: String,
    size: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GuestBinary {
    package: String,
    binary: String,
    path_env: String,
    bundled_env: String,
    destination: String,
}

type GuestField = (&'static str, fn(&GuestBinary) -> &str);

fn main() {
    println!("cargo::rustc-check-cfg=cfg(bundled_guests)");
    println!("cargo::rustc-check-cfg=cfg(bundled_okou_cli)");

    // Rebuild when embedded files change (include_str! tracks deps for rustc,
    // but CI artifact caches may not — explicit rerun-if-changed ensures correctness).
    println!(
        "cargo::rerun-if-changed=../runner-executor/scripts/agent-abnormal-exit-diagnostics.sh"
    );
    println!("cargo::rerun-if-changed=../runner-executor/scripts/rootfs-usage.py");
    println!("cargo::rerun-if-changed=scripts/build-template.sh");
    println!("cargo::rerun-if-changed=scripts/customize-rootfs.sh");
    println!("cargo::rerun-if-changed=scripts/verify-rootfs.sh");
    println!("cargo::rerun-if-changed={GUEST_BINARIES_FILE}");
    println!("cargo::rerun-if-changed=src/cli_package.rs");

    generate_addon_files();
    let guests = load_guest_binaries();
    generate_guest_binaries(&guests);

    // Build scripts run with cwd=CARGO_MANIFEST_DIR (crates/runner/), but
    // Guest binary path environment values are relative to the workspace root (crates/).
    // Resolve relative paths against the workspace root so canonicalize works.
    let workspace_root: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("CARGO_MANIFEST_DIR should have a parent")
        .to_path_buf();

    // Supply every Guest binary, the CLI tarball and its explicit manifest, or none.
    println!("cargo::rerun-if-env-changed=GUEST_CLI_PATH");
    println!("cargo::rerun-if-env-changed=GUEST_CLI_MANIFEST_PATH");
    for guest in &guests {
        println!("cargo::rerun-if-env-changed={}", guest.path_env);
    }
    let guest_cli_path = read_bundle_path("GUEST_CLI_PATH");
    let guest_cli_manifest_path = read_bundle_path("GUEST_CLI_MANIFEST_PATH");
    let paths: Vec<_> = guests
        .iter()
        .filter_map(|guest| read_bundle_path(&guest.path_env).map(|value| (guest, value)))
        .collect();
    let supplied = paths.len()
        + usize::from(guest_cli_path.is_some())
        + usize::from(guest_cli_manifest_path.is_some());
    if supplied != 0 && supplied != guests.len() + 2 {
        let mut set: Vec<_> = paths
            .iter()
            .map(|(guest, _)| guest.path_env.as_str())
            .collect();
        let mut missing: Vec<_> = guests
            .iter()
            .filter(|guest| !set.contains(&guest.path_env.as_str()))
            .map(|guest| guest.path_env.as_str())
            .collect();
        for (name, provided) in [
            ("GUEST_CLI_PATH", guest_cli_path.is_some()),
            ("GUEST_CLI_MANIFEST_PATH", guest_cli_manifest_path.is_some()),
        ] {
            if provided {
                set.push(name);
            } else {
                missing.push(name);
            }
        }
        panic!(
            "partial Guest binary and CLI paths: set={set:?}, missing={missing:?} — must set all or none"
        );
    }

    if supplied == guests.len() + 2 {
        println!("cargo::rustc-cfg=bundled_guests");
        for (guest, raw_path) in paths {
            let resolved = if Path::new(raw_path.as_str()).is_relative() {
                workspace_root.join(raw_path.as_str())
            } else {
                PathBuf::from(raw_path.as_str())
            };
            let abs = fs::canonicalize(&resolved)
                .unwrap_or_else(|e| panic!("{raw_path} (resolved to {}): {e}", resolved.display()));
            let abs_str = abs
                .to_str()
                .unwrap_or_else(|| panic!("non-UTF-8 path: {}", abs.display()));
            println!("cargo::rustc-env={}={abs_str}", guest.bundled_env);
            println!("cargo::rerun-if-changed={abs_str}");
        }
        embed_guest_cli(
            &guest_cli_path.expect("CLI path is required with Guest paths"),
            &guest_cli_manifest_path.expect("CLI manifest path is required with Guest paths"),
            &workspace_root,
        );
    }
}

fn read_bundle_path(name: &str) -> Option<String> {
    match env::var(name) {
        Ok(path) if !path.is_empty() => Some(path),
        Ok(_) | Err(env::VarError::NotPresent) => None,
        Err(env::VarError::NotUnicode(_)) => panic!("{name} must be a UTF-8 path"),
    }
}

fn cli_file_path(path: &str, workspace_root: &Path, label: &str, max_size: u64) -> PathBuf {
    let resolved = if Path::new(path).is_relative() {
        workspace_root.join(path)
    } else {
        PathBuf::from(path)
    };
    let metadata = fs::symlink_metadata(&resolved)
        .unwrap_or_else(|e| panic!("CLI {label} {}: {e}", resolved.display()));
    assert!(
        metadata.file_type().is_file() && metadata.len() > 0 && metadata.len() <= max_size,
        "CLI {label} must be a nonempty regular file no larger than {max_size} bytes: {path}"
    );
    let path = fs::canonicalize(&resolved)
        .unwrap_or_else(|e| panic!("CLI {label} {}: {e}", resolved.display()));
    println!("cargo::rerun-if-changed={}", path.display());
    path
}

fn embed_guest_cli(path: &str, manifest_path: &str, workspace_root: &Path) {
    let package = cli_file_path(path, workspace_root, "package", MAX_CLI_PACKAGE_SIZE);
    let manifest_path = cli_file_path(
        manifest_path,
        workspace_root,
        "manifest",
        MAX_CLI_MANIFEST_SIZE,
    );
    let manifest: CliManifest =
        serde_json::from_slice(&fs::read(&manifest_path).expect("read CLI manifest"))
            .expect("parse CLI manifest");
    assert_eq!(manifest.version, 1, "unsupported CLI manifest version");
    assert_eq!(
        manifest.package.path, "package.tgz",
        "unexpected CLI package path"
    );
    assert!(
        valid_lower_hex(&manifest.package.sha256, 64),
        "invalid CLI package SHA-256"
    );
    let bytes = fs::read(&package).expect("read CLI package");
    assert_eq!(
        manifest.package.size,
        bytes.len() as u64,
        "CLI package size mismatch"
    );
    assert_eq!(
        manifest.package.sha256,
        hex::encode(Sha256::digest(&bytes)),
        "CLI package digest mismatch"
    );
    let identity = cli_package::read_identity(&bytes).expect("read packed CLI identity");
    assert_eq!(
        manifest.versions, identity.versions,
        "CLI identity mismatch"
    );
    assert_eq!(
        manifest.session_construction, identity.session_construction,
        "CLI session-construction identity mismatch"
    );

    // Only the tarball is included as a Runner resource. The manifest stays a
    // build input; individual validated identity fields become compile-time
    // constants for constructing the installed rootfs manifest.
    println!("cargo::rustc-cfg=bundled_okou_cli");
    println!(
        "cargo::rustc-env=BUNDLED_OKOU_CLI_PACKAGE={}",
        package.display()
    );
    println!(
        "cargo::rustc-env=BUNDLED_OKOU_CLI_SHA256={}",
        manifest.package.sha256
    );
    println!(
        "cargo::rustc-env=BUNDLED_OKOU_CLI_SIZE={}",
        manifest.package.size
    );
    println!(
        "cargo::rustc-env=BUNDLED_OKOU_CLI_VERSION={}",
        manifest.versions.cli
    );
    println!(
        "cargo::rustc-env=BUNDLED_OKOU_PI_RUNTIME_VERSION={}",
        manifest.versions.pi_agent_runtime
    );
    println!(
        "cargo::rustc-env=BUNDLED_OKOU_PI_SDK_VERSION={}",
        manifest.versions.pi_sdk
    );
    println!(
        "cargo::rustc-env=BUNDLED_OKOU_SESSION_DIGEST={}",
        manifest.session_construction.digest
    );
}

fn load_guest_binaries() -> Vec<GuestBinary> {
    let input = fs::read_to_string(GUEST_BINARIES_FILE)
        .unwrap_or_else(|e| panic!("read {GUEST_BINARIES_FILE}: {e}"));
    let guests: Vec<GuestBinary> =
        serde_json::from_str(&input).unwrap_or_else(|e| panic!("parse {GUEST_BINARIES_FILE}: {e}"));
    if guests.is_empty() {
        panic!("{GUEST_BINARIES_FILE} must contain at least one guest binary");
    }

    let unique_fields: [GuestField; 5] = [
        ("package", |guest: &GuestBinary| guest.package.as_str()),
        ("binary", |guest: &GuestBinary| guest.binary.as_str()),
        ("pathEnv", |guest: &GuestBinary| guest.path_env.as_str()),
        ("bundledEnv", |guest: &GuestBinary| {
            guest.bundled_env.as_str()
        }),
        ("destination", |guest: &GuestBinary| {
            guest.destination.as_str()
        }),
    ];
    for (name, field) in unique_fields {
        let mut values = HashSet::new();
        for guest in &guests {
            let value = field(guest);
            if value.is_empty() {
                panic!("guest binary inventory {name} must not be empty");
            }
            if !values.insert(value) {
                panic!("duplicate guest binary inventory {name}: {value}");
            }
        }
    }
    for guest in &guests {
        let destination = guest.destination.as_str();
        let relative = destination.strip_prefix('/').unwrap_or("");
        if relative.is_empty()
            || relative
                .split('/')
                .any(|component| component.is_empty() || component == "." || component == "..")
        {
            panic!(
                "guest binary inventory destination must be an absolute, safe non-root path: {destination}"
            );
        }
    }

    guests
}

fn generate_guest_binaries(guests: &[GuestBinary]) {
    let mut code = String::from("const GUEST_DEFINITIONS: &[GuestDefinition] = &[\n");
    for guest in guests {
        code.push_str(&format!(
            "    GuestDefinition {{ name: {:?}, destination: {:?} }},\n",
            guest.binary, guest.destination
        ));
    }
    code.push_str("];\n\n#[cfg(bundled_guests)]\nmod embedded {\n");
    for (index, guest) in guests.iter().enumerate() {
        code.push_str(&format!(
            "    pub(super) const GUEST_{index}: &[u8] = include_bytes!(env!({:?}));\n",
            guest.bundled_env
        ));
    }
    code.push_str("}\n\n#[cfg(bundled_guests)]\nfn bundled_guest(name: &str) -> Option<&'static [u8]> {\n    match name {\n");
    for (index, guest) in guests.iter().enumerate() {
        code.push_str(&format!(
            "        {:?} => Some(embedded::GUEST_{index}),\n",
            guest.binary
        ));
    }
    code.push_str(
        "        _ => None,\n    }\n}\n\n#[cfg(not(bundled_guests))]\nfn bundled_guest(_name: &str) -> Option<&'static [u8]> {\n    None\n}\n",
    );

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    fs::write(out_dir.join("guest_binaries.rs"), code).unwrap();
}

/// Recursively scan `mitm-addon/src/**` and generate `addon_files.rs` with all
/// addon-runtime file contents embedded via `include_str!()`. Keys are paths
/// relative to `src/` (e.g. `"usage/counters.py"`) so the runtime extractor can
/// recreate the directory structure. Adding a new file — at any depth — requires
/// zero Rust changes.
///
/// Files picked up:
///
/// - `*.py` — Python addon source consumed by mitmdump at runtime.
/// - `LICENSE*`, `COPYING*`, `NOTICE*` — license / attribution files from
///   any third-party code shipped under the addon source tree. Required to
///   ship with the binary to satisfy license obligations such as BSD-3-Clause
///   §2 or Apache-2.0 §4(d). Extracting them alongside the code keeps source
///   and license files physically co-located both in the binary and on disk.
fn generate_addon_files() {
    let src_dir = PathBuf::from("mitm-addon/src");

    // Rebuild when any file in the directory tree changes (additions/deletions).
    println!("cargo::rerun-if-changed={}", src_dir.display());

    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    collect_addon_files(&src_dir, &src_dir, &mut entries);

    // Sort by relative path for deterministic output (multiple `__init__.py`
    // entries share a basename but differ by directory).
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut code = String::from("const ADDON_FILES: &[(&str, &str)] = &[\n");
    for (rel, abs) in &entries {
        // Use forward slashes for include_str! paths (works on all platforms).
        let path_str = abs.display().to_string().replace('\\', "/");
        code.push_str(&format!("    (\"{rel}\", include_str!(\"{path_str}\")),\n"));
    }
    code.push_str("];\n");

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    fs::write(out_dir.join("addon_files.rs"), code).unwrap();
}

fn collect_addon_files(root: &Path, cur: &Path, out: &mut Vec<(String, PathBuf)>) {
    for entry in fs::read_dir(cur).unwrap_or_else(|e| panic!("read {}: {e}", cur.display())) {
        let path = entry.unwrap().path();
        if path.is_dir() {
            // Skip Python byte-cache / venv directories that may appear during
            // local test runs — the addon image must not ship compiled caches.
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name == "__pycache__" || name.starts_with('.') {
                continue;
            }
            collect_addon_files(root, &path, out);
            continue;
        }
        if should_embed(&path) {
            let abs = fs::canonicalize(&path)
                .unwrap_or_else(|e| panic!("canonicalize {}: {e}", path.display()));
            println!("cargo::rerun-if-changed={}", abs.display());
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            out.push((rel, abs));
        }
    }
}

/// Decide whether a file under `mitm-addon/src/` ships with the runner binary.
///
/// Accepts `.py` (addon sources) and the conventional license / attribution
/// filenames used by third-party packages. `include_str!` requires valid
/// UTF-8, which all of these always are in practice.
fn should_embed(path: &Path) -> bool {
    if path.extension().is_some_and(|ext| ext == "py") {
        return true;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    name.starts_with("LICENSE") || name.starts_with("COPYING") || name.starts_with("NOTICE")
}
