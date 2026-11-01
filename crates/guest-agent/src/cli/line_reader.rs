use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

#[derive(Debug)]
pub(super) enum BoundedLineError {
    Io(io::Error),
    TooLong,
    InvalidUtf8 {
        valid_up_to: usize,
        error_len: Option<usize>,
        line_bytes: usize,
    },
}

/// Discard the remainder of one record, up to and including its LF.
///
/// [`read_bounded_utf8_line`] reports [`BoundedLineError::TooLong`] without
/// consuming the buffered bytes, so the record stays in front of the reader. A
/// caller that chooses to tolerate an over-limit record must drain it here
/// before reading again, or the next read reports the same record forever.
///
/// Yields after each non-final buffer so immediately-ready input cannot starve
/// competing controls. Cancelling and recreating this future preserves progress
/// in the reader; the caller must retain discard mode until it returns.
///
/// Returns `false` when the stream ends before an LF, which means the discarded
/// record was unterminated and no further record follows.
pub(super) async fn skip_to_line_end<R>(reader: &mut R) -> Result<bool, io::Error>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        let (consumed, reached_line_end) = {
            let available = reader.fill_buf().await?;
            if available.is_empty() {
                return Ok(false);
            }
            match available.iter().position(|byte| *byte == b'\n') {
                Some(index) => (index + 1, true),
                None => (available.len(), false),
            }
        };

        reader.consume(consumed);
        if reached_line_end {
            return Ok(true);
        }
        tokio::task::yield_now().await;
    }
}

/// Read one bounded UTF-8 record without losing partial bytes when cancelled.
///
/// The LF terminator is excluded from `max_line_bytes`. A preceding CR counts
/// toward the limit and is removed only after an LF-terminated record is
/// accepted. EOF-terminated records preserve all accumulated bytes.
pub(super) async fn read_bounded_utf8_line<R>(
    reader: &mut R,
    partial_line: &mut Vec<u8>,
    max_line_bytes: usize,
) -> Result<Option<String>, BoundedLineError>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        let (consumed, reached_line_end) = {
            let available = reader.fill_buf().await.map_err(BoundedLineError::Io)?;
            if available.is_empty() {
                if partial_line.is_empty() {
                    return Ok(None);
                }
                let line = std::mem::take(partial_line);
                return decode_line(line).map(Some);
            }

            let newline_index = available.iter().position(|byte| *byte == b'\n');
            let available_line_bytes = newline_index.unwrap_or(available.len());
            if available_line_bytes > max_line_bytes - partial_line.len() {
                return Err(BoundedLineError::TooLong);
            }

            partial_line.extend_from_slice(available.split_at(available_line_bytes).0);
            match newline_index {
                Some(index) => (index + 1, true),
                None => (available.len(), false),
            }
        };

        reader.consume(consumed);
        if reached_line_end {
            if partial_line.last() == Some(&b'\r') {
                partial_line.pop();
            }
            let line = std::mem::take(partial_line);
            return decode_line(line).map(Some);
        }
    }
}

fn decode_line(line: Vec<u8>) -> Result<String, BoundedLineError> {
    let line_bytes = line.len();
    String::from_utf8(line).map_err(|error| {
        let utf8_error = error.utf8_error();
        BoundedLineError::InvalidUtf8 {
            valid_up_to: utf8_error.valid_up_to(),
            error_len: utf8_error.error_len(),
            line_bytes,
        }
    })
}

#[cfg(test)]
mod tests;
