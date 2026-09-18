use reqwest::header::{CONTENT_ENCODING, HeaderMap};
use serde::{Serialize, Serializer};

use crate::storage_plan::ArchiveHandle;

/// Bounded evidence from a rejected archive response, without object identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct ArchiveSizeMismatch {
    #[serde(serialize_with = "serialize_byte_count")]
    expected_bytes: u64,
    /// Declared response body length; the rejected body has not been read.
    #[serde(serialize_with = "serialize_byte_count")]
    response_bytes: u64,
    source_kind: &'static str,
    source_index: usize,
    content_encoding: ContentEncoding,
}

impl ArchiveSizeMismatch {
    pub(crate) fn new(
        expected_bytes: u64,
        response_bytes: u64,
        representative: ArchiveHandle,
        headers: &HeaderMap,
    ) -> Self {
        let (source_kind, source_index) = representative.diagnostic_source();
        Self {
            expected_bytes,
            response_bytes,
            source_kind,
            source_index,
            content_encoding: ContentEncoding::from_headers(headers),
        }
    }
}

// Preserve every u64 exactly through JSON consumers with JavaScript numbers.
fn serialize_byte_count<S: Serializer>(bytes: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.collect_str(bytes)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ContentEncoding {
    Absent,
    Identity,
    Gzip,
    Other,
}

impl ContentEncoding {
    fn from_headers(headers: &HeaderMap) -> Self {
        let values = headers.get_all(CONTENT_ENCODING);
        let mut values = values.iter();
        let Some(value) = values.next() else {
            return Self::Absent;
        };
        if values.next().is_some() {
            return Self::Other;
        }
        let Ok(value) = value.to_str() else {
            return Self::Other;
        };
        match value.trim() {
            value if value.eq_ignore_ascii_case("identity") => Self::Identity,
            value if value.eq_ignore_ascii_case("gzip") => Self::Gzip,
            _ => Self::Other,
        }
    }
}
