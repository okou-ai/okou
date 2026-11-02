//! Apply an instruction file already delivered by the ordinary Storage plan.

use serde::{Deserialize, Serialize};

/// Bound the small instruction-application control input independently of file bytes.
pub const MAX_METADATA_BYTES: usize = 4 * 1024;
/// Run-local Storage mount containing the complete instruction package.
pub const STORAGE_DIR: &str = "instructions";
/// Canonical instruction package member, independent of the target framework.
pub const SOURCE_FILENAME: &str = "instructions.md";

/// Select the managed framework file; the source belongs to the current Run runtime.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstructionApplication {
    /// Framework discriminator.
    pub framework: String,
}
