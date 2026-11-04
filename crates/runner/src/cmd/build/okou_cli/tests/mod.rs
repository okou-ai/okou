use guest_contracts::okou_cli::InstalledOkouCli;
use sha2::{Digest, Sha256};

use super::test_support::{package_bytes_with_identity, stage_fixture};
use super::*;

#[tokio::test]
async fn staging_preserves_compiled_resources_and_owns_their_lifetime() {
    let expected_package = package_bytes_with_identity(b"tarball-bytes", "9.353.0", "1.36.0");
    let artifact = stage_fixture(b"tarball-bytes", "9.353.0", "1.36.0").await;
    let stage_path = artifact._temp_dir.path().to_path_buf();
    assert_eq!(artifact.cli_version(), "9.353.0");
    assert!(artifact.package_path().starts_with(&stage_path));
    assert_eq!(
        std::fs::read(artifact.package_path()).unwrap(),
        expected_package
    );
    assert_eq!(
        std::fs::read(artifact.installed_manifest_path()).unwrap(),
        artifact.installed_manifest_bytes()
    );
    let installed = InstalledOkouCli::parse(artifact.installed_manifest_bytes()).unwrap();
    assert_eq!(installed.versions.pi_agent_runtime, "1.36.0");
    assert_eq!(
        installed.package.sha256,
        hex::encode(Sha256::digest(&expected_package))
    );
    assert_eq!(
        installed.package.sha256,
        artifact.hash_input().package_sha256
    );
    assert_eq!(installed.package.size, expected_package.len() as u64);
    assert_eq!(
        installed.entrypoint,
        "/usr/local/lib/okou-cli/9.353.0/okou.js"
    );
    drop(artifact);
    assert!(
        !stage_path.exists(),
        "owned staging resources must be cleaned up"
    );
}

#[cfg(bundled_okou_cli)]
#[tokio::test]
async fn embedded_bundle_stages_exact_compiled_resources() {
    use crate::cmd::embedded_cli;

    let artifact = OkouCliArtifact::resolve_embedded().await.unwrap().unwrap();
    assert_eq!(
        std::fs::read(artifact.package_path()).unwrap(),
        embedded_cli::package()
    );
    assert_eq!(
        artifact.installed_manifest_bytes(),
        embedded_cli::installed_manifest()
    );
    assert_eq!(
        std::fs::read(artifact.installed_manifest_path()).unwrap(),
        embedded_cli::installed_manifest()
    );
    let installed = InstalledOkouCli::parse(embedded_cli::installed_manifest()).unwrap();
    assert_eq!(installed.versions.cli, artifact.cli_version());
    assert_eq!(
        installed.package.sha256,
        artifact.hash_input().package_sha256
    );
    assert_eq!(
        installed.package.sha256,
        hex::encode(Sha256::digest(embedded_cli::package()))
    );
    assert_eq!(installed.package.size, embedded_cli::package().len() as u64);
}

#[cfg(not(bundled_okou_cli))]
#[tokio::test]
async fn local_unbundled_runner_has_no_embedded_cli() {
    assert!(OkouCliArtifact::resolve_embedded().await.unwrap().is_none());
}
