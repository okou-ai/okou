use std::fs::File;
use std::io::{self, Write};
use std::os::fd::{AsFd, BorrowedFd};

use super::{MAX_BATCH_PAYLOAD_BYTES, OutputMode, write_batch_with};
use guest_contracts::sealed_input::SealedInput;

fn write_sealed_batch(input: BorrowedFd<'_>) -> io::Result<()> {
    let mapping = SealedInput::map(input, MAX_BATCH_PAYLOAD_BYTES)?;
    let payload = mapping.as_bytes();
    write_batch_with(payload, OutputMode::CreateParents, |output, content| {
        // The batch decoder borrowed the content from this sealed mapping.
        let offset = (content.as_ptr().addr() - payload.as_ptr().addr()) as u64;
        copy_sealed_content(input, offset, content, output)
    })
}

fn copy_sealed_content(
    input: BorrowedFd<'_>,
    mut offset: u64,
    mut content: &[u8],
    output: &mut File,
) -> io::Result<()> {
    use rustix::io::Errno;

    while !content.is_empty() {
        match rustix::fs::sendfile(&*output, input, Some(&mut offset), content.len()) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(written) => {
                content = content
                    .get(written..)
                    .ok_or_else(|| io::Error::other("sendfile returned an invalid byte count"))?;
            }
            Err(Errno::INTR) => continue,
            Err(Errno::INVAL | Errno::NOSYS | Errno::NOTSUP | Errno::XDEV) => {
                // The destination is already positioned past any copied bytes.
                return output.write_all(content);
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
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
