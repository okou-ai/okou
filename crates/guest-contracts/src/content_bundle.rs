//! Private verified-file application contract; package downloads remain on the host.
use serde::{Deserialize, Serialize};
/// Maximum installed bundle metadata, independent of content byte limits.
// 501 paths of up to 256 UTF-16 units, including JSON escaping and source paths.
pub const MAX_METADATA_BYTES: usize = 1024 * 1024;
/// One verified file privately staged by Runner.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BundleFileSource {
    /// Canonical relative package path.
    pub path: String,
    /// Run-private source file.
    pub source: String,
}
/// Apply one complete input package.
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum BundleApplication {
    /// Replace one framework-managed instruction file.
    Instructions {
        /// Framework discriminator.
        framework: String,
        /// Private instructions source.
        source: String,
    },
    /// Replace a complete managed Workflow skill directory.
    Skill {
        /// Validated skills mount.
        mount: String,
        /// Complete validated package files.
        files: Vec<BundleFileSource>,
    },
}
