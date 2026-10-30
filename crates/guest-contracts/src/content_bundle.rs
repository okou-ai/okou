//! Private archive application contract; package downloads remain on the host.
use serde::{Deserialize, Serialize};
/// Only an archive identity, private source and destination cross exec stdin.
pub const MAX_METADATA_BYTES: usize = 4 * 1024;
/// One verified archive privately staged by Runner's chunked file transport.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleArchiveSource {
    /// Run-private compressed archive.
    pub source: String,
    /// Expected SHA-256 of the compressed bytes.
    pub sha256: String,
    /// Expected compressed byte count.
    pub archive_bytes: u64,
}
/// Apply one complete input package.
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum BundleApplication {
    /// Replace one framework-managed instruction file.
    Instructions {
        /// Framework discriminator.
        framework: String,
        /// Complete instructions archive.
        archive: BundleArchiveSource,
    },
    /// Replace a complete managed Workflow skill directory.
    Skill {
        /// Validated skills mount.
        mount: String,
        /// Complete Workflow archive, including SKILL.md and attachments.
        archive: BundleArchiveSource,
    },
}
