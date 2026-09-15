use api_contracts::generated::constants::runners::{
    SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
    SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT,
};
use serde::Serialize;

use crate::types::{
    ResumeSessionHistoryDownloadSource, ResumeSessionHistoryEncoding, ResumeSessionHistoryRef,
    SessionHistorySizeBucket,
};

/// Low-cardinality session-history telemetry fields emitted with a sandbox op.
///
/// The ref observation fields are produced by the runner-local
/// [`SessionHistoryProbe`](crate::executor::SessionHistoryProbe). They describe
/// probe state at materializer start, not a storage-cache hit or global
/// download coordination state.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct SessionHistoryTelemetryFields {
    encoding: &'static str,
    #[serde(rename = "session_history_raw_size_bucket")]
    raw_size_bucket: &'static str,
    #[serde(rename = "session_history_encoded_size_bucket")]
    encoded_size_bucket: &'static str,
    #[serde(rename = "session_history_compression_ratio_bucket")]
    compression_ratio_bucket: &'static str,
    #[serde(
        rename = "session_history_ref_seen_recently",
        skip_serializing_if = "Option::is_none"
    )]
    /// Whether a matching ref identity had a prior observation within the
    /// probe's one-hour default window at materializer start.
    ref_seen_recently: Option<&'static str>,
    #[serde(
        rename = "session_history_ref_download_inflight",
        skip_serializing_if = "Option::is_none"
    )]
    /// Whether a prior matching probe registration was active before the
    /// current materializer registered its own download.
    ref_download_inflight: Option<&'static str>,
    #[serde(
        rename = "session_history_content_length_state",
        skip_serializing_if = "Option::is_none"
    )]
    content_length_state: Option<&'static str>,
    #[serde(
        rename = "session_history_content_encoding_state",
        skip_serializing_if = "Option::is_none"
    )]
    content_encoding_state: Option<&'static str>,
    #[serde(
        rename = "session_history_transfer_encoding_state",
        skip_serializing_if = "Option::is_none"
    )]
    transfer_encoding_state: Option<&'static str>,
    #[serde(
        rename = "session_history_download_source",
        skip_serializing_if = "Option::is_none"
    )]
    download_source: Option<&'static str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SessionHistoryTelemetryMetadata {
    encoding: &'static str,
    raw_size_bucket: &'static str,
    encoded_size_bucket: &'static str,
    compression_ratio_bucket: &'static str,
    download_source: Option<ResumeSessionHistoryDownloadSource>,
    cache_probe: Option<SessionHistoryCacheProbeMetadata>,
    response: Option<SessionHistoryResponseTelemetryMetadata>,
}

/// Best-effort, runner-local observation attached to a session-history download.
///
/// The probe identity is the tuple of hash, encoding, raw size, and encoded
/// size. URL and download source are not part of the identity. The default
/// probe uses one hour as its recent-observation window and tracks at most
/// 4,096 identities; expiry and capacity eviction can therefore make either
/// observation false, including for an entry that was previously active. This
/// metadata does not indicate that history bytes are cached or that a download
/// was suppressed.
///
/// Both values are sampled before the current materializer adds its
/// registration. `seen_recently` means that the prior matching entry was seen
/// within the observation window. `download_inflight` means that the prior
/// matching entry had an active registration at that moment. Registrations are
/// cleared by the materializer/worker lifecycle and shared guard cleanup on
/// completion, cancellation, abort, and drop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SessionHistoryCacheProbeMetadata {
    seen_recently: bool,
    download_inflight: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SessionHistoryResponseTelemetryMetadata {
    content_length_state: SessionHistoryContentLengthState,
    content_encoding_state: SessionHistoryContentEncodingState,
    transfer_encoding_state: SessionHistoryTransferEncodingState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SessionHistoryContentLengthState {
    Absent,
    MatchesExpected,
    MismatchesExpected,
    PresentWithoutExpected,
    Oversized,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SessionHistoryContentEncodingState {
    Absent,
    Gzip,
    Zstd,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SessionHistoryTransferEncodingState {
    Absent,
    Chunked,
    Other,
}

impl SessionHistoryTelemetryMetadata {
    pub(crate) fn from_ref(history_ref: &ResumeSessionHistoryRef) -> Self {
        let encoding = history_ref.encoding;
        Self {
            encoding: session_history_encoding_value(encoding),
            raw_size_bucket: size_bucket(history_ref.raw_size),
            encoded_size_bucket: size_bucket(history_ref.encoded_size),
            compression_ratio_bucket: compression_ratio_bucket(
                encoding,
                history_ref.raw_size,
                history_ref.encoded_size,
            ),
            download_source: history_ref.download_source,
            cache_probe: None,
            response: None,
        }
    }

    pub(crate) fn with_cache_probe(
        mut self,
        cache_probe: SessionHistoryCacheProbeMetadata,
    ) -> Self {
        self.cache_probe = Some(cache_probe);
        self
    }

    pub(crate) fn with_response(
        mut self,
        response: SessionHistoryResponseTelemetryMetadata,
    ) -> Self {
        self.response = Some(response);
        self
    }

    pub(crate) fn encoding(self) -> &'static str {
        self.encoding
    }

    fn raw_size_bucket(self) -> &'static str {
        self.raw_size_bucket
    }

    fn encoded_size_bucket(self) -> &'static str {
        self.encoded_size_bucket
    }

    fn compression_ratio_bucket(self) -> &'static str {
        self.compression_ratio_bucket
    }

    fn download_source(self) -> Option<&'static str> {
        self.download_source
            .and_then(session_history_download_source_value)
    }

    fn cache_probe(self) -> Option<SessionHistoryCacheProbeMetadata> {
        self.cache_probe
    }

    pub(crate) fn response(self) -> Option<SessionHistoryResponseTelemetryMetadata> {
        self.response
    }
}

impl From<SessionHistoryTelemetryMetadata> for SessionHistoryTelemetryFields {
    fn from(metadata: SessionHistoryTelemetryMetadata) -> Self {
        let cache_probe = metadata.cache_probe();
        let response = metadata.response();
        Self {
            encoding: metadata.encoding(),
            raw_size_bucket: metadata.raw_size_bucket(),
            encoded_size_bucket: metadata.encoded_size_bucket(),
            compression_ratio_bucket: metadata.compression_ratio_bucket(),
            ref_seen_recently: cache_probe
                .map(SessionHistoryCacheProbeMetadata::seen_recently_value),
            ref_download_inflight: cache_probe
                .map(SessionHistoryCacheProbeMetadata::download_inflight_value),
            content_length_state: response
                .map(SessionHistoryResponseTelemetryMetadata::content_length_value),
            content_encoding_state: response
                .map(SessionHistoryResponseTelemetryMetadata::content_encoding_value),
            transfer_encoding_state: response
                .map(SessionHistoryResponseTelemetryMetadata::transfer_encoding_value),
            download_source: metadata.download_source(),
        }
    }
}

#[cfg(test)]
impl SessionHistoryTelemetryFields {
    pub(crate) const fn encoding(self) -> &'static str {
        self.encoding
    }

    pub(crate) const fn raw_size_bucket(self) -> &'static str {
        self.raw_size_bucket
    }

    pub(crate) const fn encoded_size_bucket(self) -> &'static str {
        self.encoded_size_bucket
    }

    pub(crate) const fn compression_ratio_bucket(self) -> &'static str {
        self.compression_ratio_bucket
    }

    pub(crate) const fn ref_seen_recently(self) -> Option<&'static str> {
        self.ref_seen_recently
    }

    pub(crate) const fn ref_download_inflight(self) -> Option<&'static str> {
        self.ref_download_inflight
    }

    pub(crate) const fn download_source(self) -> Option<&'static str> {
        self.download_source
    }
}

impl SessionHistoryCacheProbeMetadata {
    pub(crate) const fn new(seen_recently: bool, download_inflight: bool) -> Self {
        Self {
            seen_recently,
            download_inflight,
        }
    }

    fn seen_recently_value(self) -> &'static str {
        bool_string_value(self.seen_recently)
    }

    fn download_inflight_value(self) -> &'static str {
        bool_string_value(self.download_inflight)
    }
}

impl SessionHistoryResponseTelemetryMetadata {
    pub(crate) const fn new(
        content_length_state: SessionHistoryContentLengthState,
        content_encoding_state: SessionHistoryContentEncodingState,
        transfer_encoding_state: SessionHistoryTransferEncodingState,
    ) -> Self {
        Self {
            content_length_state,
            content_encoding_state,
            transfer_encoding_state,
        }
    }

    #[cfg(test)]
    pub(crate) const fn content_length_state(self) -> SessionHistoryContentLengthState {
        self.content_length_state
    }

    #[cfg(test)]
    pub(crate) const fn content_encoding_state(self) -> SessionHistoryContentEncodingState {
        self.content_encoding_state
    }

    #[cfg(test)]
    pub(crate) const fn transfer_encoding_state(self) -> SessionHistoryTransferEncodingState {
        self.transfer_encoding_state
    }

    fn content_length_value(self) -> &'static str {
        self.content_length_state.value()
    }

    fn content_encoding_value(self) -> &'static str {
        self.content_encoding_state.value()
    }

    fn transfer_encoding_value(self) -> &'static str {
        self.transfer_encoding_state.value()
    }
}

impl SessionHistoryContentLengthState {
    const fn value(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::MatchesExpected => "matches_expected",
            Self::MismatchesExpected => "mismatches_expected",
            Self::PresentWithoutExpected => "present_without_expected",
            Self::Oversized => "oversized",
        }
    }
}

impl SessionHistoryContentEncodingState {
    const fn value(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Gzip => "gzip",
            Self::Zstd => "zstd",
            Self::Other => "other",
        }
    }
}

impl SessionHistoryTransferEncodingState {
    const fn value(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Chunked => "chunked",
            Self::Other => "other",
        }
    }
}

const fn session_history_encoding_value(encoding: ResumeSessionHistoryEncoding) -> &'static str {
    match encoding {
        ResumeSessionHistoryEncoding::Identity => "identity",
        ResumeSessionHistoryEncoding::Gzip => "gzip",
        ResumeSessionHistoryEncoding::Zstd => "zstd",
    }
}

const fn session_history_download_source_value(
    source: ResumeSessionHistoryDownloadSource,
) -> Option<&'static str> {
    match source {
        ResumeSessionHistoryDownloadSource::ConfiguredPublicEndpoint => {
            Some(SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT)
        }
        ResumeSessionHistoryDownloadSource::DefaultR2Endpoint => {
            Some(SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT)
        }
        ResumeSessionHistoryDownloadSource::Unknown => None,
    }
}

const fn size_bucket(size: u64) -> &'static str {
    SessionHistorySizeBucket::from_size(size).as_str()
}

pub(crate) const fn session_history_prefix_extension_action_type(
    raw_extension_size: u64,
) -> &'static str {
    match SessionHistorySizeBucket::from_size(raw_extension_size) {
        SessionHistorySizeBucket::LessThan64Kib => {
            "session_history_requested_larger_prefix_extension_lt_64_kib"
        }
        SessionHistorySizeBucket::From64To256Kib => {
            "session_history_requested_larger_prefix_extension_64_256_kib"
        }
        SessionHistorySizeBucket::From256KibTo1Mib => {
            "session_history_requested_larger_prefix_extension_256_kib_1_mib"
        }
        SessionHistorySizeBucket::From1To4Mib => {
            "session_history_requested_larger_prefix_extension_1_4_mib"
        }
        SessionHistorySizeBucket::From4To16Mib => {
            "session_history_requested_larger_prefix_extension_4_16_mib"
        }
        SessionHistorySizeBucket::From16To64Mib => {
            "session_history_requested_larger_prefix_extension_16_64_mib"
        }
        SessionHistorySizeBucket::From64To128Mib => {
            "session_history_requested_larger_prefix_extension_64_128_mib"
        }
    }
}

fn compression_ratio_bucket(
    encoding: ResumeSessionHistoryEncoding,
    raw_size: u64,
    encoded_size: u64,
) -> &'static str {
    if encoding == ResumeSessionHistoryEncoding::Identity {
        return "identity";
    }
    if raw_size == 0 {
        return "ge_1";
    }

    let ratio = encoded_size as f64 / raw_size as f64;
    if ratio < 0.25 {
        "lt_0_25"
    } else if ratio < 0.5 {
        "0_25_0_5"
    } else if ratio < 0.75 {
        "0_5_0_75"
    } else if ratio < 1.0 {
        "0_75_1"
    } else {
        "ge_1"
    }
}

const fn bool_string_value(value: bool) -> &'static str {
    if value { "true" } else { "false" }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ResumeSessionHistoryRefKind;

    fn metadata(
        download_source: ResumeSessionHistoryDownloadSource,
    ) -> SessionHistoryTelemetryMetadata {
        SessionHistoryTelemetryMetadata::from_ref(&ResumeSessionHistoryRef {
            kind: ResumeSessionHistoryRefKind::Blob,
            hash: "hash".to_string(),
            url: "https://example.com/history".to_string(),
            encoding: ResumeSessionHistoryEncoding::Gzip,
            raw_size: 128 * 1024,
            encoded_size: 16 * 1024,
            download_source: Some(download_source),
        })
    }

    #[test]
    fn size_bucket_boundaries_keep_stable_labels_and_actions() {
        const SIZE_64_KIB: u64 = 64 * 1024;
        const SIZE_256_KIB: u64 = 256 * 1024;
        const SIZE_1_MIB: u64 = 1024 * 1024;
        const SIZE_4_MIB: u64 = 4 * SIZE_1_MIB;
        const SIZE_16_MIB: u64 = 16 * SIZE_1_MIB;
        const SIZE_64_MIB: u64 = 64 * SIZE_1_MIB;
        let cases = [
            (
                0,
                "lt_64_kib",
                "session_history_requested_larger_prefix_extension_lt_64_kib",
            ),
            (
                SIZE_64_KIB - 1,
                "lt_64_kib",
                "session_history_requested_larger_prefix_extension_lt_64_kib",
            ),
            (
                SIZE_64_KIB,
                "64_256_kib",
                "session_history_requested_larger_prefix_extension_64_256_kib",
            ),
            (
                SIZE_256_KIB - 1,
                "64_256_kib",
                "session_history_requested_larger_prefix_extension_64_256_kib",
            ),
            (
                SIZE_256_KIB,
                "256_kib_1_mib",
                "session_history_requested_larger_prefix_extension_256_kib_1_mib",
            ),
            (
                SIZE_1_MIB - 1,
                "256_kib_1_mib",
                "session_history_requested_larger_prefix_extension_256_kib_1_mib",
            ),
            (
                SIZE_1_MIB,
                "1_4_mib",
                "session_history_requested_larger_prefix_extension_1_4_mib",
            ),
            (
                SIZE_4_MIB - 1,
                "1_4_mib",
                "session_history_requested_larger_prefix_extension_1_4_mib",
            ),
            (
                SIZE_4_MIB,
                "4_16_mib",
                "session_history_requested_larger_prefix_extension_4_16_mib",
            ),
            (
                SIZE_16_MIB - 1,
                "4_16_mib",
                "session_history_requested_larger_prefix_extension_4_16_mib",
            ),
            (
                SIZE_16_MIB,
                "16_64_mib",
                "session_history_requested_larger_prefix_extension_16_64_mib",
            ),
            (
                SIZE_64_MIB - 1,
                "16_64_mib",
                "session_history_requested_larger_prefix_extension_16_64_mib",
            ),
            (
                SIZE_64_MIB,
                "64_128_mib",
                "session_history_requested_larger_prefix_extension_64_128_mib",
            ),
        ];

        for (size, expected_label, expected_action) in cases {
            assert_eq!(size_bucket(size), expected_label);
            assert_eq!(
                session_history_prefix_extension_action_type(size),
                expected_action
            );
        }
    }

    #[test]
    fn compression_ratio_boundaries_keep_stable_serialized_labels() {
        let cases = [
            (ResumeSessionHistoryEncoding::Gzip, 1024, 255, "lt_0_25"),
            (ResumeSessionHistoryEncoding::Gzip, 1024, 256, "0_25_0_5"),
            (ResumeSessionHistoryEncoding::Gzip, 1024, 511, "0_25_0_5"),
            (ResumeSessionHistoryEncoding::Gzip, 1024, 512, "0_5_0_75"),
            (ResumeSessionHistoryEncoding::Gzip, 1024, 767, "0_5_0_75"),
            (ResumeSessionHistoryEncoding::Gzip, 1024, 768, "0_75_1"),
            (ResumeSessionHistoryEncoding::Gzip, 1024, 1023, "0_75_1"),
            (ResumeSessionHistoryEncoding::Gzip, 1024, 1024, "ge_1"),
            (ResumeSessionHistoryEncoding::Identity, 1024, 0, "identity"),
            (ResumeSessionHistoryEncoding::Gzip, 0, 0, "ge_1"),
        ];

        for (encoding, raw_size, encoded_size, expected_label) in cases {
            let fields = SessionHistoryTelemetryFields::from(
                SessionHistoryTelemetryMetadata::from_ref(&ResumeSessionHistoryRef {
                    kind: ResumeSessionHistoryRefKind::Blob,
                    hash: "hash".to_string(),
                    url: "https://example.com/history".to_string(),
                    encoding,
                    raw_size,
                    encoded_size,
                    download_source: None,
                }),
            );
            let serialized = serde_json::to_value(fields).unwrap();

            assert_eq!(
                serialized
                    .get("session_history_compression_ratio_bucket")
                    .and_then(serde_json::Value::as_str),
                Some(expected_label),
                "encoding={encoding:?} raw_size={raw_size} encoded_size={encoded_size}"
            );
        }
    }

    #[test]
    fn metadata_serializes_stable_session_history_fields() {
        let fields = SessionHistoryTelemetryFields::from(
            metadata(ResumeSessionHistoryDownloadSource::ConfiguredPublicEndpoint)
                .with_cache_probe(SessionHistoryCacheProbeMetadata::new(true, false))
                .with_response(SessionHistoryResponseTelemetryMetadata::new(
                    SessionHistoryContentLengthState::MatchesExpected,
                    SessionHistoryContentEncodingState::Absent,
                    SessionHistoryTransferEncodingState::Absent,
                )),
        );

        assert_eq!(
            serde_json::to_value(fields).unwrap(),
            serde_json::json!({
                "encoding": "gzip",
                "session_history_raw_size_bucket": "64_256_kib",
                "session_history_encoded_size_bucket": "lt_64_kib",
                "session_history_compression_ratio_bucket": "lt_0_25",
                "session_history_ref_seen_recently": "true",
                "session_history_ref_download_inflight": "false",
                "session_history_content_length_state": "matches_expected",
                "session_history_content_encoding_state": "absent",
                "session_history_transfer_encoding_state": "absent",
                "session_history_download_source": "configured_public_endpoint",
            })
        );
    }

    #[test]
    fn unknown_download_source_is_omitted() {
        let fields = SessionHistoryTelemetryFields::from(metadata(
            ResumeSessionHistoryDownloadSource::Unknown,
        ));

        assert_eq!(
            serde_json::to_value(fields).unwrap(),
            serde_json::json!({
                "encoding": "gzip",
                "session_history_raw_size_bucket": "64_256_kib",
                "session_history_encoded_size_bucket": "lt_64_kib",
                "session_history_compression_ratio_bucket": "lt_0_25",
            })
        );
    }
}
