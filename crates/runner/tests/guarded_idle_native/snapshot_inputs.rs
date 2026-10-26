//! Original snapshot identity for native preparation fixtures.

use serde::Deserialize;

use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Inputs {
    snapshot_path: PathBuf,
    snapshot_memory_mb: u32,
}

pub(super) struct Original {
    pub path: PathBuf,
    pub bytes: u64,
    pub raw: Vec<u8>,
}

pub(super) async fn original(
    budget: &ResourceBudget,
    proof: &evidence::Case,
) -> TestResult<Original> {
    let raw = std::fs::read(std::env::var("OKOU_TEST_OPTIONAL_MEMORY_POLICY")?)?;
    let supplied: Inputs = serde_json::from_slice(&raw)?;
    let original = PathBuf::from(std::env::var("OKOU_TEST_RPC_SNAPSHOT_DIR")?).join("memory.bin");
    let bytes = original.metadata()?.len();
    if std::fs::canonicalize(&original)? != std::fs::canonicalize(&supplied.snapshot_path)?
        || supplied.snapshot_memory_mb != 4096
        || bytes != 4096 * 1024 * 1024
        || budget.allocated() != (2, 4096, 1)
    {
        return Err(
            io::Error::other("startup original snapshot shape/identity/lease is invalid").into(),
        );
    }
    let checked = original.clone();
    let hash = proof.snapshot_memory_hash()?.to_owned();
    tokio::task::spawn_blocking(move || evidence::verify_file(&checked, &hash)).await??;
    Ok(Original {
        path: original,
        bytes,
        raw,
    })
}
