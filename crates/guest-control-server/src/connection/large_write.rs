use std::fs::File;
use std::io::{self, Read, Write};

use guest_control_proto::IncompleteFrame;

use crate::handlers::create_batch_input;

// The 12–16 MiB serving tail pays for several full payload copies. Smaller
// writes keep the existing decoder and worker path.
pub(super) const STREAMED_BATCH_MIN_BYTES: usize = 12 * 1024 * 1024;

/// Finish receiving the bounded payload, retaining coalesced following bytes
/// in scratch for the connection decoder. EOF drops the partial input.
pub(super) fn receive(
    reader: &mut impl Read,
    scratch: &mut [u8],
    frame: &IncompleteFrame,
) -> io::Result<Option<(File, usize)>> {
    let mut input = create_batch_input()?;
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
            return Ok(Some((input, received - remaining)));
        }
        remaining -= received;
    }
}

#[cfg(test)]
mod tests;
