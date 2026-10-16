//! Accepted Claude Code stdout preserves exact-limit, CRLF normalization, and
//! EOF-final-record behavior through the production execution entry point.

use guest_agent_tests as common;

use guest_contracts::stdout_framing::ORDINARY_CLI_STDOUT_MAX_LINE_BYTES;
use std::io::{Read, Seek, SeekFrom};
use std::time::Duration;

const CRLF_RECORD: &[u8] = b"crlf-record\n";
const EOF_RECORD: &[u8] = b"eof-record\n";

#[tokio::test]
async fn accepted_stdout_record_boundaries_preserve_raw_logging()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(&mock, tmp.path(), "@stdout-record-boundaries", 3, 1)?;
    }

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let execution = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("accepted stdout boundary records should complete promptly")?;

    assert_eq!(execution.exit_code, common::CLEAN_EXIT);
    assert!(execution.control_error.is_none());
    assert!(execution.cli_termination.is_none());
    assert_eq!(execution.last_event_sequence, None);

    let expected_large_line_start = CRLF_RECORD.len() as u64;
    let expected_eof_record_start =
        expected_large_line_start + ORDINARY_CLI_STDOUT_MAX_LINE_BYTES as u64 + 1;
    let expected_log_bytes = expected_eof_record_start + EOF_RECORD.len() as u64;
    let mut log = std::fs::File::open(runtime.paths.agent_log_file())?;
    assert_eq!(log.metadata()?.len(), expected_log_bytes);

    let mut crlf_record = [0u8; CRLF_RECORD.len()];
    log.read_exact(&mut crlf_record)?;
    assert_eq!(&crlf_record, CRLF_RECORD);

    log.seek(SeekFrom::Start(expected_large_line_start))?;
    let mut large_line_prefix = [0u8; 8];
    log.read_exact(&mut large_line_prefix)?;
    assert_eq!(large_line_prefix, [b'x'; 8]);

    log.seek(SeekFrom::Start(expected_eof_record_start - 2))?;
    let mut large_line_end = [0u8; 2];
    log.read_exact(&mut large_line_end)?;
    assert_eq!(large_line_end, [b'x', b'\n']);

    let mut eof_record = [0u8; EOF_RECORD.len()];
    log.read_exact(&mut eof_record)?;
    assert_eq!(&eof_record, EOF_RECORD);

    Ok(())
}
