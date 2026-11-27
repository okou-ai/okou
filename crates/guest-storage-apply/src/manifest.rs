use std::{fmt, fs};

pub(crate) use guest_contracts::storage_manifest::{ArtifactEntry, Manifest, StorageEntry};

pub(crate) fn load(manifest_path: &str) -> Result<Manifest, ManifestLoadError> {
    let manifest_json = fs::read_to_string(manifest_path).map_err(ManifestLoadError::Read)?;
    parse(manifest_json.as_bytes()).map_err(ManifestLoadError::Parse)
}

pub(crate) fn parse(manifest_json: &[u8]) -> Result<Manifest, ManifestParseError> {
    serde_json::from_slice(manifest_json).map_err(|error| ManifestParseError {
        category: error.classify(),
        line: error.line(),
        column: error.column(),
    })
}

// Serde's error text can quote sensitive manifest values. Retain only bounded
// metadata so callers cannot accidentally log the original message or source.
pub(crate) struct ManifestParseError {
    category: serde_json::error::Category,
    line: usize,
    column: usize,
}

impl fmt::Display for ManifestParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "category={:?} line={} column={}",
            self.category, self.line, self.column
        )
    }
}

pub(crate) enum ManifestLoadError {
    Read(std::io::Error),
    Parse(ManifestParseError),
}
