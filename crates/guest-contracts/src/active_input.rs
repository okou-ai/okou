//! Runner-to-guest active-input process-control payload contract.
//!
//! This module owns the active-input JSON encoding and the allocation-free way
//! to measure its encoded size. It does not own transport admission: producers
//! must ensure that the encoded bytes fit the process-control frame before
//! delivery. The inclusive production limit is the
//! [`process_control_ipc::MAX_CONTROL_PAYLOAD_BYTES`](https://github.com/okou-ai/okou/blob/main/crates/process-control-ipc/src/lib.rs)
//! boundary, currently 1 MiB (1,048,576 bytes); Runner and process-control
//! enforce that boundary.
//!
//! Runner encodes borrowed delivery IDs and text through this module before
//! process-control transport. Guest-agent decodes the bytes into owned,
//! validated values before applying run-scoped queue and receipt policy. This
//! module also owns the stable closed-lifecycle diagnostic that survives the
//! generic process-control rejection boundary.

use std::fmt;
use std::io::{self, Write};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const ACTIVE_INPUT_TYPE: &str = "active-input";

/// Stable diagnostic returned when Guest active-input admission has closed.
///
/// Runner uses this value to classify the expected close race separately from
/// other application-level rejections.
pub const ACTIVE_INPUT_CLOSED_DIAGNOSTIC: &str = "active input is closed";

#[derive(Serialize)]
struct ActiveInputEncodeWire<'a> {
    #[serde(rename = "type")]
    payload_type: &'static str,
    #[serde(rename = "deliveryId")]
    delivery_id: &'a str,
    text: &'a str,
}

impl<'a> ActiveInputEncodeWire<'a> {
    fn new(delivery_id: &'a str, text: &'a str) -> Self {
        Self {
            payload_type: ACTIVE_INPUT_TYPE,
            delivery_id,
            text,
        }
    }
}

#[derive(Deserialize)]
struct ActiveInputDecodeWire {
    #[serde(rename = "type")]
    payload_type: String,
    #[serde(rename = "deliveryId")]
    delivery_id: String,
    text: String,
}

/// Owned active-input fields after shared wire validation.
#[derive(Debug, PartialEq, Eq)]
pub struct DecodedActiveInput {
    delivery_id: String,
    text: String,
}

impl DecodedActiveInput {
    /// Consume the decoded payload and return its delivery ID and text.
    pub fn into_parts(self) -> (String, String) {
        (self.delivery_id, self.text)
    }
}

/// Classification of an invalid active-input control payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveInputDecodeError {
    /// The bytes are not JSON with all required string fields.
    InvalidPayload,
    /// The payload discriminant is not `active-input`.
    UnsupportedType,
    /// The follow-up text is empty.
    EmptyText,
    /// The delivery ID is not a UUID.
    InvalidDeliveryId,
    /// The delivery ID is a UUID but not in lowercase hyphenated form.
    NonCanonicalDeliveryId,
}

impl fmt::Display for ActiveInputDecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPayload => "active-input payload is invalid",
            Self::UnsupportedType => "active-input payload type is unsupported",
            Self::EmptyText => "active-input text is empty",
            Self::InvalidDeliveryId => "active-input delivery ID is invalid",
            Self::NonCanonicalDeliveryId => "active-input delivery ID is not canonical",
        })
    }
}

impl std::error::Error for ActiveInputDecodeError {}

/// Encode an active-input payload from borrowed producer fields.
///
/// This function only serializes the JSON payload. A successful result does
/// not mean that the returned bytes fit the process-control transport frame.
/// The producer remains responsible for supplying valid field values and
/// should use [`encoded_active_input_len`] to preflight the exact encoded byte
/// count before transport. The inclusive production boundary is the
/// [`process_control_ipc::MAX_CONTROL_PAYLOAD_BYTES`](https://github.com/okou-ai/okou/blob/main/crates/process-control-ipc/src/lib.rs)
/// value, currently 1 MiB (1,048,576 bytes), and Runner/process-control own
/// its admission check. Use [`decode_active_input`] at the consumer trust
/// boundary to validate the fields.
pub fn encode_active_input(delivery_id: &str, text: &str) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(&ActiveInputEncodeWire::new(delivery_id, text))
}

#[derive(Default)]
struct CountingWriter {
    len: usize,
}

impl Write for CountingWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.len = self
            .len
            .checked_add(buffer.len())
            .ok_or_else(|| io::Error::other("serialized active-input payload length overflow"))?;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Calculate the exact encoded byte length without allocating the payload.
///
/// Producers should compare the returned count with the inclusive
/// [`process_control_ipc::MAX_CONTROL_PAYLOAD_BYTES`](https://github.com/okou-ai/okou/blob/main/crates/process-control-ipc/src/lib.rs)
/// transport boundary before delivery. That boundary is currently 1 MiB
/// (1,048,576 bytes), and Runner/process-control enforce it; this helper only
/// measures the JSON bytes and does not reject an oversized payload. Therefore,
/// a payload of 1,048,577 encoded bytes may still be returned successfully by
/// [`encode_active_input`], but it is not transport-admissible.
pub fn encoded_active_input_len(delivery_id: &str, text: &str) -> Result<usize, serde_json::Error> {
    let mut counter = CountingWriter::default();
    serde_json::to_writer(&mut counter, &ActiveInputEncodeWire::new(delivery_id, text))?;
    Ok(counter.len)
}

/// Decode and validate one active-input process-control payload.
///
/// Unknown JSON fields are accepted so a newer producer can add optional
/// metadata without breaking an older guest consumer.
pub fn decode_active_input(bytes: &[u8]) -> Result<DecodedActiveInput, ActiveInputDecodeError> {
    let wire = serde_json::from_slice::<ActiveInputDecodeWire>(bytes)
        .map_err(|_| ActiveInputDecodeError::InvalidPayload)?;
    if wire.payload_type != ACTIVE_INPUT_TYPE {
        return Err(ActiveInputDecodeError::UnsupportedType);
    }
    if wire.text.is_empty() {
        return Err(ActiveInputDecodeError::EmptyText);
    }
    let parsed = Uuid::parse_str(&wire.delivery_id)
        .map_err(|_| ActiveInputDecodeError::InvalidDeliveryId)?;
    if parsed.hyphenated().to_string() != wire.delivery_id {
        return Err(ActiveInputDecodeError::NonCanonicalDeliveryId);
    }
    Ok(DecodedActiveInput {
        delivery_id: wire.delivery_id,
        text: wire.text,
    })
}
