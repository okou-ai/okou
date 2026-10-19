use std::io::Write;

use sandbox::ExecTermination;

/// Append terminal text after the caller's raw stderr, preserving its line state
/// for any command-specific warnings that follow.
pub(super) fn write_terminal_diagnostic(
    stderr: &mut impl Write,
    termination: &ExecTermination,
    raw_stderr: &[u8],
    diagnostic: &str,
    include_diagnostic: bool,
    line_open: &mut bool,
) {
    let (fallback, force_diagnostic) = match termination {
        ExecTermination::Exited { .. } => (None, false),
        ExecTermination::TimedOut => (Some("Timeout"), false),
        ExecTermination::Cancelled => (Some("Cancelled"), true),
        ExecTermination::StartFailed | ExecTermination::WaitFailed => (None, true),
    };
    let include_diagnostic = include_diagnostic || force_diagnostic;

    if raw_stderr.is_empty() {
        if let Some(message) = fallback {
            let _ = writeln!(stderr, "{message}");
            *line_open = false;
        }
    } else if include_diagnostic && !diagnostic.is_empty() && *line_open {
        let _ = writeln!(stderr);
        *line_open = false;
    }

    if include_diagnostic && !diagnostic.is_empty() {
        let _ = writeln!(stderr, "{diagnostic}");
        *line_open = false;
    }
}
