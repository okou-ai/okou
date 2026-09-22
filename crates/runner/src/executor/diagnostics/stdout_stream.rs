use std::io::{self, SeekFrom};
use std::path::{Path, PathBuf};

use sandbox::ProcessOutputReceiver;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use tracing::warn;

use super::super::{
    STDOUT_STREAM_INCOMPLETE_MARKER, STDOUT_STREAM_LIMIT_MARKER, STDOUT_STREAM_OVERFLOW_MARKER,
};
use runner_types::ids::RunId;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(in crate::executor) struct AgentStdoutStreamDiagnostics {
    pub(in crate::executor) bytes_written: u64,
    pub(in crate::executor) chunk_truncated: bool,
    pub(in crate::executor) stream_overflowed: bool,
    pub(in crate::executor) stream_incomplete: bool,
}

impl AgentStdoutStreamDiagnostics {
    pub(in crate::executor) fn is_empty(self) -> bool {
        !self.chunk_truncated && !self.stream_overflowed && !self.stream_incomplete
    }
}

#[derive(Debug, thiserror::Error)]
pub(in crate::executor) enum StdoutDrainError {
    #[error("failed to open host log file {path}: {source}")]
    Open { path: PathBuf, source: io::Error },
    #[error("failed to write stdout chunk to host log {path}: {source}")]
    Write { path: PathBuf, source: io::Error },
    #[error("failed to flush stdout log {path}: {source}")]
    Flush { path: PathBuf, source: io::Error },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(in crate::executor) struct StdoutDrainReport {
    pub(in crate::executor) bytes_written: u64,
    pub(in crate::executor) chunk_truncated: bool,
    pub(in crate::executor) stream_incomplete: bool,
}

/// Drain stdout chunks from the process receiver and write them to a host file.
pub(in crate::executor) async fn drain_stdout_to_file(
    mut rx: ProcessOutputReceiver,
    path: PathBuf,
    stop: CancellationToken,
) -> Result<StdoutDrainReport, StdoutDrainError> {
    let file = crate::log_file::open_append(&path, false).map(tokio::fs::File::from_std);
    let mut file = match file {
        Ok(f) => f,
        Err(e) => {
            return Err(StdoutDrainError::Open { path, source: e });
        }
    };
    let mut report = StdoutDrainReport::default();
    loop {
        let chunk = if report.stream_incomplete {
            rx.recv().await
        } else {
            tokio::select! {
                biased;
                () = stop.cancelled() => {
                    rx.close();
                    report.stream_incomplete = true;
                    continue;
                }
                chunk = rx.recv() => chunk,
            }
        };
        let Some(chunk) = chunk else {
            break;
        };
        report.bytes_written = report
            .bytes_written
            .saturating_add(u64::try_from(chunk.bytes.len()).unwrap_or(u64::MAX));
        if chunk.truncated {
            report.chunk_truncated = true;
            warn!(path = %path.display(), "stdout stream chunk was truncated before host log write");
        }
        if let Err(e) = file.write_all(&chunk.bytes).await {
            return Err(StdoutDrainError::Write { path, source: e });
        }
    }
    // Flush to ensure the last blocking write completes before we return.
    // tokio::fs::File::poll_write returns Ready before the blocking write finishes,
    // so without flush the caller may observe incomplete file contents.
    if let Err(e) = file.flush().await {
        return Err(StdoutDrainError::Flush { path, source: e });
    }
    Ok(report)
}

pub(in crate::executor) async fn append_stdout_stream_diagnostics_to_stream_log(
    run_id: RunId,
    path: &Path,
    diagnostics: AgentStdoutStreamDiagnostics,
) {
    if diagnostics.is_empty() {
        return;
    }

    if let Err(e) = append_stdout_stream_diagnostics(path, diagnostics).await {
        warn!(
            run_id = %run_id,
            path = %path.display(),
            error = %e,
            "failed to append stdout stream diagnostic marker to host stream log"
        );
    }
}

pub(in crate::executor) async fn append_stdout_stream_diagnostics(
    path: &Path,
    diagnostics: AgentStdoutStreamDiagnostics,
) -> io::Result<()> {
    if diagnostics.is_empty() {
        return Ok(());
    }

    let mut file = tokio::fs::File::from_std(crate::log_file::open_append(path, true)?);

    if file.metadata().await?.len() > 0 {
        file.seek(SeekFrom::End(-1)).await?;
        let mut last = [0u8; 1];
        file.read_exact(&mut last).await?;
        if last[0] != b'\n' {
            file.write_all(b"\n").await?;
        }
    }
    if diagnostics.chunk_truncated {
        file.write_all(STDOUT_STREAM_LIMIT_MARKER).await?;
    }
    if diagnostics.stream_overflowed {
        file.write_all(STDOUT_STREAM_OVERFLOW_MARKER).await?;
    }
    if diagnostics.stream_incomplete {
        file.write_all(STDOUT_STREAM_INCOMPLETE_MARKER).await?;
    }
    file.flush().await
}
