use super::*;

#[test]
fn e2e_duration_from_api_start_returns_elapsed_duration() {
    let duration = e2e_duration_from_api_start("1700000000000", 1_700_000_001_250);

    assert_eq!(duration, Some(Duration::from_millis(1_250)));
}

#[test]
fn e2e_duration_from_api_start_clamps_future_start_to_zero() {
    let duration = e2e_duration_from_api_start("1700000001250", 1_700_000_000_000);

    assert_eq!(duration, Some(Duration::ZERO));
}

#[test]
fn e2e_duration_from_api_start_ignores_empty_input() {
    let duration = e2e_duration_from_api_start("", 1_700_000_001_250);

    assert_eq!(duration, None);
}

#[test]
fn e2e_duration_from_api_start_ignores_non_numeric_input() {
    let duration = e2e_duration_from_api_start("not-a-timestamp", 1_700_000_001_250);

    assert_eq!(duration, None);
}

#[test]
fn e2e_duration_from_api_start_ignores_seconds_shaped_input() {
    let duration = e2e_duration_from_api_start("1700000000", 1_700_000_001_250);

    assert_eq!(duration, None);
}
