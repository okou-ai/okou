use super::*;

#[test]
fn result_after_cleanup_returns_original_result_when_cleanup_succeeds() {
    assert_eq!(result_after_cleanup(Ok(7), Vec::new()).unwrap(), 7);
    assert_eq!(
        result_after_cleanup::<u8>(Err("fio failed".to_string()), Vec::new()).unwrap_err(),
        "fio failed"
    );
}

#[test]
fn result_after_cleanup_reports_cleanup_errors() {
    assert_eq!(
        result_after_cleanup(Ok(7), vec!["remove failed".to_string()]).unwrap_err(),
        "cleanup failed: remove failed"
    );
    assert_eq!(
        result_after_cleanup::<u8>(
            Err("fio failed".to_string()),
            vec!["destroy failed".to_string(), "detach failed".to_string()],
        )
        .unwrap_err(),
        "fio failed; cleanup also failed: destroy failed; detach failed"
    );
}
