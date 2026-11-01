//! Bounded record reader for Firecracker process output.
//!
//! Normal records retain at most [`PROCESS_LOG_RECORD_MAX_BYTES`]. Oversized
//! records produce one [`ProcessLogRecord::Truncated`] event while the reader
//! continues discarding through the next delimiter or EOF.

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt};

pub(crate) const PROCESS_LOG_RECORD_MAX_BYTES: usize = 16 * 1024;
pub(crate) const PROCESS_LOG_RECORD_TRUNCATED: &str =
    "firecracker log record omitted: exceeded 16 KiB limit";

const PROCESS_LOG_READ_BUFFER_BYTES: usize = 8 * 1024;

pub(crate) enum ProcessLogRecord<'a> {
    Line(&'a str),
    Truncated,
}

pub(crate) async fn read_process_log_records<R, F>(
    mut reader: R,
    mut on_record: F,
) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    F: for<'a> FnMut(ProcessLogRecord<'a>),
{
    let mut buffer = [0u8; PROCESS_LOG_READ_BUFFER_BYTES];
    let mut line = Vec::with_capacity(PROCESS_LOG_RECORD_MAX_BYTES.min(1024));
    let mut discarding = false;
    let mut pending_cr_at_limit = false;

    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }

        for &byte in buffer.iter().take(read) {
            if discarding {
                if byte == b'\n' {
                    discarding = false;
                }
                continue;
            }

            if pending_cr_at_limit {
                pending_cr_at_limit = false;
                if byte == b'\n' {
                    emit_line(&line, &mut on_record)?;
                    line.clear();
                } else {
                    on_record(ProcessLogRecord::Truncated);
                    line.clear();
                    discarding = true;
                }
                continue;
            }

            if byte == b'\n' {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                emit_line(&line, &mut on_record)?;
                line.clear();
            } else if line.len() < PROCESS_LOG_RECORD_MAX_BYTES {
                line.push(byte);
            } else if byte == b'\r' {
                pending_cr_at_limit = true;
            } else {
                on_record(ProcessLogRecord::Truncated);
                line.clear();
                discarding = true;
            }
        }
    }

    if pending_cr_at_limit {
        on_record(ProcessLogRecord::Truncated);
    } else if !discarding {
        emit_line(&line, &mut on_record)?;
    }

    Ok(())
}

fn emit_line<F>(line: &[u8], on_record: &mut F) -> io::Result<()>
where
    F: for<'a> FnMut(ProcessLogRecord<'a>),
{
    if line.is_empty() {
        return Ok(());
    }

    let line = std::str::from_utf8(line)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    on_record(ProcessLogRecord::Line(line));
    Ok(())
}

#[cfg(test)]
mod tests;
