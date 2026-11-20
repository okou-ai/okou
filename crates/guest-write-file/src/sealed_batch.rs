use std::io::{self, Write};
use std::os::fd::{AsFd, BorrowedFd};

use super::{MAX_BATCH_PAYLOAD_BYTES, OutputMode, write_batch};
use guest_contracts::sealed_input::SealedInput;

fn write_sealed_batch(input: BorrowedFd<'_>) -> io::Result<()> {
    let mapping = SealedInput::map(input, MAX_BATCH_PAYLOAD_BYTES)?;
    write_batch(mapping.as_bytes(), OutputMode::CreateParents)
}

/// Write an ordinary batch from an immutable stdin descriptor supplied by guest control.
/// Returns the process exit code.
pub fn run_sealed_batch(mut stderr: impl Write) -> i32 {
    match write_sealed_batch(io::stdin().as_fd()) {
        Ok(()) => 0,
        Err(error) => {
            let _ = writeln!(stderr, "guest-write-file: {error}");
            1
        }
    }
}

#[cfg(test)]
mod tests;
