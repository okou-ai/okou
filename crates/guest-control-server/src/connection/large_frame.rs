use std::fs::File;
use std::io::{self, Read, Write};
use std::ops::RangeInclusive;

use guest_control_proto::{Decoder, IncompleteFrame};

use crate::error::to_io_error;
use crate::handlers::create_batch_input;

// Ordinary batches at the sealed-helper cutoff are still incomplete after a
// socket read. Receive them into the helper's input before the decoder can
// build a heap buffer for the whole payload.
pub(super) const STREAMED_BATCH_MIN_BYTES: usize = 4 * 1024 * 1024;

// Smaller inputs benefit from the decoder's reusable buffer. Above this
// range, the 9.36 MB mixed replay regressed on three Guests during first use.
pub(super) const OWNED_STORAGE_PAYLOAD_BYTES: RangeInclusive<usize> =
    4 * 1024 * 1024..=8 * 1024 * 1024;

pub(super) fn receive_write(
    reader: &mut impl Read,
    scratch: &mut [u8],
    frame: &IncompleteFrame,
) -> io::Result<Option<(File, usize)>> {
    let mut input = create_batch_input()?;
    Ok(receive_into(reader, scratch, frame, &mut input)?.map(|retained| (input, retained)))
}

/// Finish receiving the bounded payload. Preflight coalesced following bytes
/// before dispatch and retain them in scratch for the ordinary decoder.
/// EOF leaves the caller with an incomplete input to discard.
pub(super) fn receive_into(
    reader: &mut impl Read,
    scratch: &mut [u8],
    frame: &IncompleteFrame,
    mut input: impl Write,
) -> io::Result<Option<usize>> {
    let prefix = frame.received_payload();
    input.write_all(prefix)?;
    let mut remaining = frame.payload_len - prefix.len();
    loop {
        let received = match reader.read(scratch) {
            Ok(0) => return Ok(None),
            Ok(received) => received,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        input.write_all(scratch.split_at(remaining.min(received)).0)?;
        if remaining <= received {
            scratch.copy_within(remaining..received, 0);
            let retained = received - remaining;
            Decoder::validate_buffered_framing(scratch.split_at(retained).0)
                .map_err(to_io_error)?;
            return Ok(Some(retained));
        }
        remaining -= received;
    }
}

#[cfg(test)]
mod tests;
