use guest_telemetry::log::{clear_system_log_file, set_system_log_file};
use guest_telemetry::{log_error, log_info, log_warn};

#[test]
fn logging_macros_in_expression_positions_append_formatted_lines() {
    let dir = tempfile::tempdir().expect("create system log fixture");
    let path = dir.path().join("system.log");
    set_system_log_file(&path);

    let log_calls: [fn(); 3] = [
        || log_info!("sandbox:macro-test", "value {}", 1),
        || log_warn!("sandbox:macro-test", "value {}", 2),
        || log_error!("sandbox:macro-test", "value {}", 3),
    ];
    for log_call in log_calls {
        log_call();
    }
    clear_system_log_file();

    let content = std::fs::read_to_string(path).expect("read system log");
    let lines: Vec<_> = content.lines().collect();
    assert_eq!(lines.len(), 3);
    assert!(content.ends_with('\n'));
    for (line, expected) in lines.iter().zip([
        "[INFO] [sandbox:macro-test] value 1",
        "[WARN] [sandbox:macro-test] value 2",
        "[ERROR] [sandbox:macro-test] value 3",
    ]) {
        assert!(line.ends_with(expected), "unexpected log line: {line:?}");
    }
}
