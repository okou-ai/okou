use std::path::Path;

use tracing::info;
use uuid::Uuid;

use super::RunnerProcessIdentity;
use crate::error::{HostError, HostResult};
use crate::private_fs;

/// Load runner ID from `{base_dir}/runner_id`, or generate a new UUID and persist it.
async fn load_or_generate_runner_id(base_dir: &Path) -> HostResult<Uuid> {
    let path = base_dir.join("runner_id");
    match private_fs::read_private_file_to_string(&path).await? {
        Some(contents) => Uuid::parse_str(contents.trim()).map_err(|e| {
            HostError::Config(format!("invalid runner_id in {}: {e}", path.display()))
        }),
        None => {
            let id = Uuid::new_v4();
            let id_text = id.to_string();
            private_fs::write_private_file(&path, id_text.as_bytes()).await?;
            info!(runner_id = %id, "generated new runner ID");
            Ok(id)
        }
    }
}

/// Load the runner UUID and allocate its next process generation.
///
/// The caller holds the exclusive runner base-directory lock, so generation
/// allocation has one writer for the lifetime of this runner identity.
pub async fn load_runner_process_identity(base_dir: &Path) -> HostResult<RunnerProcessIdentity> {
    let runner_id = load_or_generate_runner_id(base_dir).await?;
    let path = base_dir.join("heartbeat_generation");
    let previous = match private_fs::read_private_file_to_string(&path).await? {
        Some(contents) => contents.trim().parse::<u64>().map_err(|error| {
            HostError::Config(format!(
                "invalid heartbeat generation in {}: {error}",
                path.display()
            ))
        })?,
        None => 0,
    };
    let heartbeat_generation = previous.checked_add(1).ok_or_else(|| {
        HostError::Config(format!(
            "heartbeat generation in {} exceeds the wire safe-integer range",
            path.display()
        ))
    })?;
    let identity =
        RunnerProcessIdentity::new(runner_id, heartbeat_generation).map_err(|error| {
            HostError::Config(format!(
                "invalid heartbeat generation in {}: {error}",
                path.display(),
            ))
        })?;
    private_fs::write_private_file(&path, heartbeat_generation.to_string().as_bytes()).await?;
    Ok(identity)
}

#[cfg(test)]
mod tests;
