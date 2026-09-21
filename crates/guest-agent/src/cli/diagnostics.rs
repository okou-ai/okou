//! Raw CLI stderr diagnostic tail collection.
//!
//! This module keeps stderr collection bounded and intentionally leaves final
//! secret masking to the shared CLI execution path.

use guest_contracts::cli_stderr_diagnostics::{
    CLI_STDERR_OMITTED_LONG_LINE, CLI_STDERR_RESULT_MAX_LINE_BYTES, CLI_STDERR_RESULT_MAX_LINES,
};
use std::collections::VecDeque;
use tokio::io::{AsyncRead, AsyncReadExt};

use super::pi_preparation_timing;

const STDERR_READ_BUFFER_BYTES: usize = 8 * 1024;

/// Structured stderr envelopes a framework's collector recognizes live.
///
/// Collection stays bounded and diagnostic-only by default. Pi additionally
/// carries preparation observations on stderr, and those must be recorded as
/// they arrive rather than from the retained tail, so their timestamps reflect
/// when the phase actually finished.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum CliStderrLineObserver {
    #[default]
    None,
    PiPreparationTiming,
}

impl CliStderrLineObserver {
    fn observe(self, line: &[u8]) {
        match self {
            Self::None => {}
            Self::PiPreparationTiming => {
                pi_preparation_timing::record_pi_preparation_timing_line(line);
            }
        }
    }
}

fn push_stderr_result_line(lines: &mut VecDeque<String>, line: String) {
    if lines.len() == CLI_STDERR_RESULT_MAX_LINES {
        lines.pop_front();
    }
    lines.push_back(line);
}

fn push_decoded_stderr_result_line(lines: &mut VecDeque<String>, line: &[u8]) {
    let line = String::from_utf8_lossy(line);
    if line.len() > CLI_STDERR_RESULT_MAX_LINE_BYTES {
        push_stderr_result_line(lines, CLI_STDERR_OMITTED_LONG_LINE.to_string());
    } else {
        push_stderr_result_line(lines, line.into_owned());
    }
}

fn finish_stderr_result_line(
    lines: &mut VecDeque<String>,
    line: &mut Vec<u8>,
    line_omitted: &mut bool,
    strip_trailing_cr: bool,
    observer: CliStderrLineObserver,
) {
    if *line_omitted {
        push_stderr_result_line(lines, CLI_STDERR_OMITTED_LONG_LINE.to_string());
    } else {
        if strip_trailing_cr && line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.len() > CLI_STDERR_RESULT_MAX_LINE_BYTES {
            push_stderr_result_line(lines, CLI_STDERR_OMITTED_LONG_LINE.to_string());
        } else {
            observer.observe(line);
            push_decoded_stderr_result_line(lines, line);
        }
    }
    line.clear();
    *line_omitted = false;
}

/// Collect a bounded stderr tail without observing individual lines.
pub(super) async fn collect_stderr_result_tail<R>(stderr: R) -> Vec<String>
where
    R: AsyncRead + Unpin,
{
    collect_stderr_result_tail_observed(stderr, CliStderrLineObserver::None).await
}

pub(super) async fn collect_stderr_result_tail_observed<R>(
    mut stderr: R,
    observer: CliStderrLineObserver,
) -> Vec<String>
where
    R: AsyncRead + Unpin,
{
    let mut lines = VecDeque::with_capacity(CLI_STDERR_RESULT_MAX_LINES);
    let mut line = Vec::with_capacity(CLI_STDERR_RESULT_MAX_LINE_BYTES.min(1024));
    let mut line_omitted = false;
    let mut buffer = [0u8; STDERR_READ_BUFFER_BYTES];

    loop {
        let read = match stderr.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => break,
        };

        for &byte in buffer.iter().take(read) {
            if byte == b'\n' {
                finish_stderr_result_line(&mut lines, &mut line, &mut line_omitted, true, observer);
                continue;
            }

            if line_omitted {
                continue;
            }

            if line.len() < CLI_STDERR_RESULT_MAX_LINE_BYTES
                || (byte == b'\r' && line.len() == CLI_STDERR_RESULT_MAX_LINE_BYTES)
            {
                line.push(byte);
            } else {
                line.clear();
                line_omitted = true;
            }
        }
    }

    if !line.is_empty() || line_omitted {
        finish_stderr_result_line(&mut lines, &mut line, &mut line_omitted, false, observer);
    }

    lines.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pi_memory_phase2_terminal_lines_survive_stderr_collection() {
        let fixtures: Vec<serde_json::Value> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/pi-memory-phase2-terminal.json"
        )))
        .unwrap();
        for fixture in fixtures {
            let stderr = fixture["stderr"].as_str().unwrap();
            assert!(stderr.len() < CLI_STDERR_RESULT_MAX_LINE_BYTES);
            for suffix in ["\n", ""] {
                let wire = format!("{stderr}{suffix}");
                assert_eq!(collect_stderr_result_tail(wire.as_bytes()).await, [stderr]);
            }
        }
    }
}
