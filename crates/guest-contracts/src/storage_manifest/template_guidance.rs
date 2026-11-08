//! Bounds for immutable working-directory template packages, independent of Skills.

use serde::{Deserialize, Serialize};

/// Private execution/cache namespace; no generic registry row is created.
pub const TEMPLATE_GUIDANCE_STORAGE_NAME: &str = "template-guidance";
/// Template file payload budget.
pub const MAX_TEMPLATE_CONTENT_BYTES: u64 = 100 * 1024 * 1024;
/// Canonical tar budget, including bounded paths, PAX metadata and padding.
pub const MAX_TEMPLATE_TAR_BYTES: u64 = 102 * 1024 * 1024;
/// Canonical gzip budget, including worst-case compression overhead.
pub const MAX_TEMPLATE_ARCHIVE_BYTES: u64 = 103 * 1024 * 1024;
/// Maximum number of regular files.
pub const MAX_TEMPLATE_FILES: usize = 200;
/// Maximum payload of a regular file.
pub const MAX_TEMPLATE_FILE_BYTES: u64 = 25 * 1024 * 1024;

/// Complete compressed-byte identity carried through cache and remote sources.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateGuidanceReference {
    /// Lowercase SHA-256 of the complete canonical tar.gz.
    pub sha256: String,
    /// Exact compressed size, not an unpacked file-size estimate.
    pub archive_bytes: u64,
}

impl TemplateGuidanceReference {
    /// Validate a reference before opening or allocating its archive.
    pub fn validate(&self) -> Result<(), String> {
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.archive_bytes == 0
            || self.archive_bytes > MAX_TEMPLATE_ARCHIVE_BYTES
        {
            return Err("Invalid template guidance identity or size".into());
        }
        Ok(())
    }
}
