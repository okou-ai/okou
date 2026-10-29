use std::path::PathBuf;

use crate::deps::{
    FIRECRACKER_ARCHIVE_SHA256_AARCH64, FIRECRACKER_ARCHIVE_SHA256_X86_64,
    FIRECRACKER_ARCHIVE_SIZE_AARCH64, FIRECRACKER_ARCHIVE_SIZE_X86_64, FIRECRACKER_SHA256_AARCH64,
    FIRECRACKER_SHA256_X86_64, FIRECRACKER_SIZE_AARCH64, FIRECRACKER_SIZE_X86_64,
    FIRECRACKER_VERSION, KERNEL_SHA256_AARCH64, KERNEL_SHA256_X86_64, KERNEL_SIZE_AARCH64,
    KERNEL_SIZE_X86_64, KERNEL_VERSION, MITMDUMP_SHA256_AARCH64, MITMDUMP_SHA256_X86_64,
    MITMDUMP_SIZE_AARCH64, MITMDUMP_SIZE_X86_64, MITMDUMP_TAR_ENTRY,
    MITMPROXY_ARCHIVE_SHA256_AARCH64, MITMPROXY_ARCHIVE_SHA256_X86_64,
    MITMPROXY_ARCHIVE_SIZE_AARCH64, MITMPROXY_ARCHIVE_SIZE_X86_64, MITMPROXY_VERSION,
    firecracker_tar_entry, firecracker_url, kernel_url, mitmdump_url,
};
use crate::error::RunnerResult;
use runner_host::paths::HomePaths;

use super::{
    SETUP_EXECUTABLE_ARTIFACT_MODE, SETUP_KERNEL_ARTIFACT_MODE, SetupArtifactIdentity,
    download_and_extract, download_to_temp, ensure_artifact_installed, select_sha, select_size,
    verify_and_install,
};

enum SetupArtifactSource {
    Direct,
    TarEntry {
        entry_name: String,
        archive: SetupArtifactIdentity,
    },
}

struct SetupArtifact {
    label: &'static str,
    display_name: String,
    target: PathBuf,
    installed: SetupArtifactIdentity,
    mode: u32,
    url: String,
    source: SetupArtifactSource,
}

pub(super) async fn install_firecracker(
    client: &reqwest::Client,
    paths: &HomePaths,
    arch: &str,
) -> RunnerResult<()> {
    install_setup_artifact(client, firecracker_artifact(paths, arch)).await
}

pub(super) async fn install_kernel(
    client: &reqwest::Client,
    paths: &HomePaths,
    arch: &str,
) -> RunnerResult<()> {
    install_setup_artifact(client, kernel_artifact(paths, arch)).await
}

pub(super) async fn install_mitmdump(
    client: &reqwest::Client,
    paths: &HomePaths,
    arch: &str,
) -> RunnerResult<()> {
    install_setup_artifact(client, mitmdump_artifact(paths, arch)).await
}

async fn install_setup_artifact(
    client: &reqwest::Client,
    artifact: SetupArtifact,
) -> RunnerResult<()> {
    if ensure_artifact_installed(&artifact.target, &artifact.installed, artifact.mode).await? {
        tracing::info!(
            "[OK] {} already installed, skipping download",
            artifact.display_name
        );
        return Ok(());
    }

    tracing::info!("downloading {} from {}", artifact.label, artifact.url);

    let produced = match &artifact.source {
        SetupArtifactSource::Direct => {
            download_to_temp(
                client,
                &artifact.url,
                &artifact.target,
                "download",
                artifact.label,
                &artifact.installed,
            )
            .await?
        }
        SetupArtifactSource::TarEntry {
            entry_name,
            archive,
        } => {
            download_and_extract(
                client,
                &artifact.url,
                artifact.label,
                entry_name,
                &artifact.target,
                archive,
                &artifact.installed,
            )
            .await?
        }
    };

    verify_and_install(
        produced,
        &artifact.installed,
        artifact.label,
        &artifact.target,
        artifact.mode,
    )
    .await?;
    tracing::info!("[OK] {} installed", artifact.display_name);
    Ok(())
}

fn setup_artifact_identity(size: u64, sha256: &str) -> SetupArtifactIdentity {
    SetupArtifactIdentity {
        size,
        sha256: sha256.to_owned(),
    }
}

fn firecracker_artifact(paths: &HomePaths, arch: &str) -> SetupArtifact {
    SetupArtifact {
        label: "firecracker",
        display_name: format!("firecracker {FIRECRACKER_VERSION}"),
        target: paths.firecracker_bin(FIRECRACKER_VERSION),
        installed: setup_artifact_identity(
            select_size(arch, FIRECRACKER_SIZE_X86_64, FIRECRACKER_SIZE_AARCH64),
            select_sha(arch, FIRECRACKER_SHA256_X86_64, FIRECRACKER_SHA256_AARCH64),
        ),
        mode: SETUP_EXECUTABLE_ARTIFACT_MODE,
        url: firecracker_url(arch),
        source: SetupArtifactSource::TarEntry {
            entry_name: firecracker_tar_entry(arch),
            archive: setup_artifact_identity(
                select_size(
                    arch,
                    FIRECRACKER_ARCHIVE_SIZE_X86_64,
                    FIRECRACKER_ARCHIVE_SIZE_AARCH64,
                ),
                select_sha(
                    arch,
                    FIRECRACKER_ARCHIVE_SHA256_X86_64,
                    FIRECRACKER_ARCHIVE_SHA256_AARCH64,
                ),
            ),
        },
    }
}

fn kernel_artifact(paths: &HomePaths, arch: &str) -> SetupArtifact {
    SetupArtifact {
        label: "kernel",
        display_name: format!("kernel vmlinux-{KERNEL_VERSION}"),
        target: paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION),
        installed: setup_artifact_identity(
            select_size(arch, KERNEL_SIZE_X86_64, KERNEL_SIZE_AARCH64),
            select_sha(arch, KERNEL_SHA256_X86_64, KERNEL_SHA256_AARCH64),
        ),
        mode: SETUP_KERNEL_ARTIFACT_MODE,
        url: kernel_url(arch),
        source: SetupArtifactSource::Direct,
    }
}

fn mitmdump_artifact(paths: &HomePaths, arch: &str) -> SetupArtifact {
    SetupArtifact {
        label: "mitmdump",
        display_name: format!("mitmdump {MITMPROXY_VERSION}"),
        target: paths.mitmdump_bin(MITMPROXY_VERSION),
        installed: setup_artifact_identity(
            select_size(arch, MITMDUMP_SIZE_X86_64, MITMDUMP_SIZE_AARCH64),
            select_sha(arch, MITMDUMP_SHA256_X86_64, MITMDUMP_SHA256_AARCH64),
        ),
        mode: SETUP_EXECUTABLE_ARTIFACT_MODE,
        url: mitmdump_url(arch),
        source: SetupArtifactSource::TarEntry {
            entry_name: MITMDUMP_TAR_ENTRY.to_owned(),
            archive: setup_artifact_identity(
                select_size(
                    arch,
                    MITMPROXY_ARCHIVE_SIZE_X86_64,
                    MITMPROXY_ARCHIVE_SIZE_AARCH64,
                ),
                select_sha(
                    arch,
                    MITMPROXY_ARCHIVE_SHA256_X86_64,
                    MITMPROXY_ARCHIVE_SHA256_AARCH64,
                ),
            ),
        },
    }
}

#[cfg(test)]
mod tests;
