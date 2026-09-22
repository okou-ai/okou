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

            partial_line.extend(available.iter().take(available_line_bytes).copied());
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
mod tests {
    use super::*;

    const LIMIT: usize = 8;

    fn reader(bytes: &'static str) -> tokio::io::BufReader<&'static [u8]> {
        tokio::io::BufReader::new(bytes.as_bytes())
    }

    #[tokio::test]
    async fn skipping_an_over_limit_record_resumes_at_the_next_one() {
        let mut reader = reader("oversized-record\nkept\n");
        let mut partial = Vec::new();

        let too_long = read_bounded_utf8_line(&mut reader, &mut partial, LIMIT).await;
        assert!(matches!(too_long, Err(BoundedLineError::TooLong)));

        // The failing read leaves the record in front of the reader, so the
        // next read repeats the failure until the remainder is drained.
        partial.clear();
        let repeated = read_bounded_utf8_line(&mut reader, &mut partial, LIMIT).await;
        assert!(matches!(repeated, Err(BoundedLineError::TooLong)));

        partial.clear();
        assert!(skip_to_line_end(&mut reader).await.expect("drain"));

        let next = read_bounded_utf8_line(&mut reader, &mut partial, LIMIT)
            .await
            .expect("record after the discarded one");
        assert_eq!(next.as_deref(), Some("kept"));
    }

    #[tokio::test]
    async fn skipping_an_unterminated_record_reports_no_terminator() {
        let mut reader = reader("oversized-record-without-newline");
        let mut partial = Vec::new();

        assert!(matches!(
            read_bounded_utf8_line(&mut reader, &mut partial, LIMIT).await,
            Err(BoundedLineError::TooLong)
        ));

        partial.clear();
        assert!(!skip_to_line_end(&mut reader).await.expect("drain"));

        // The stream is exhausted, so the caller observes an ordinary EOF.
        let eof = read_bounded_utf8_line(&mut reader, &mut partial, LIMIT)
            .await
            .expect("eof after a drained unterminated record");
        assert_eq!(eof, None);
    }

    #[tokio::test]
    async fn skipping_consumes_exactly_one_record() {
        let mut reader = reader("first\nsecond\n");
        let mut partial = Vec::new();

        assert!(skip_to_line_end(&mut reader).await.expect("drain"));

        let next = read_bounded_utf8_line(&mut reader, &mut partial, LIMIT)
            .await
            .expect("second record");
        assert_eq!(next.as_deref(), Some("second"));
    }
}
