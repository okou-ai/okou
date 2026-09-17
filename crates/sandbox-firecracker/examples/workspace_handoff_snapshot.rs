//! Create the isolated handoff study snapshot directly at its final Runner path.

use std::error::Error;
use std::path::PathBuf;

use sandbox::SnapshotCreateConfig;
use sandbox_firecracker::{
    SnapshotOutputPaths, SnapshotOutputValidation, create_snapshot, validate_snapshot_output,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Config {
    id: String,
    binary_path: PathBuf,
    kernel_path: PathBuf,
    rootfs_path: PathBuf,
    output_dir: PathBuf,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    let config_path = std::env::args()
        .nth(1)
        .ok_or("expected snapshot config JSON")?;
    let config: Config = serde_json::from_slice(&std::fs::read(config_path)?)?;
    if config.id.len() != 64 || !config.id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("snapshot identity must be a 64-character hex hash".into());
    }
    if std::fs::symlink_metadata(&config.output_dir).is_ok() {
        return Err("refusing to replace an existing snapshot path".into());
    }
    let output = SnapshotOutputPaths::new(config.output_dir.clone());
    create_snapshot(SnapshotCreateConfig {
        id: config.id,
        binary_path: config.binary_path,
        kernel_path: config.kernel_path,
        rootfs_path: config.rootfs_path,
        output_dir: config.output_dir,
        vcpu_count: 2,
        memory_mb: 4096,
        workspace_disk_mb: 10240,
    })
    .await?;
    if validate_snapshot_output(&output).await? != SnapshotOutputValidation::Complete {
        return Err("snapshot did not satisfy the completion contract".into());
    }
    println!("snapshot-complete");
    Ok(())
}
