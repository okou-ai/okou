//! Shared byte progress for synchronous log appends.

use std::io::{self, IoSlice, Write};

/// Writes ordered log slices, advancing partially written slices in place.
/// An empty slice list succeeds immediately.
///
/// # Errors
///
/// Retries [`io::ErrorKind::Interrupted`] and propagates other writer errors.
/// A zero-byte write returns [`io::ErrorKind::WriteZero`] with the supplied message.
pub fn write_all_vectored(
    writer: &mut impl Write,
    mut slices: &mut [IoSlice<'_>],
    write_zero_message: &'static str,
) -> io::Result<()> {
    while !slices.is_empty() {
        let written = match writer.write_vectored(slices) {
            Ok(0) => {
                return Err(io::Error::new(io::ErrorKind::WriteZero, write_zero_message));
            }
            Ok(written) => written,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        IoSlice::advance_slices(&mut slices, written);
    }
    Ok(())
}
