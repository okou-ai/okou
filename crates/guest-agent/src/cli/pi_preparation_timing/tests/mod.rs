use super::*;

fn observation(line: &str) -> Option<(String, u128, bool, &'static str)> {
    parse_observation(line.as_bytes()).map(|observation| {
        (
            observation.op_type,
            observation.duration.as_millis(),
            observation.success,
            observation.outcome,
        )
    })
}

#[test]
fn parses_a_successful_sandbox_phase() {
    assert_eq!(
        observation(
            r#"{"type":"pi_preparation_timing","runId":"run-1","phase":"session_services","durationMs":41.6,"outcome":"success"}"#
        ),
        Some((
            "pi_prepare_session_services".to_string(),
            41,
            true,
            "success"
        ))
    );
}

#[test]
fn a_non_success_outcome_is_recorded_as_a_failed_operation() {
    assert_eq!(
        observation(
            r#"{"type":"pi_preparation_timing","phase":"session_create","durationMs":2,"outcome":"cancelled"}"#
        ),
        Some((
            "pi_prepare_session_create".to_string(),
            2,
            false,
            "cancelled"
        ))
    );
}

#[test]
fn every_observed_phase_maps_to_the_sandbox_op_name() {
    for phase in OBSERVED_PHASES {
        let line = format!(
            r#"{{"type":"pi_preparation_timing","phase":"{phase}","durationMs":1,"outcome":"success"}}"#
        );
        assert_eq!(
            observation(&line).map(|parsed| parsed.0),
            Some(format!("pi_prepare_{phase}"))
        );
    }
}

#[test]
fn unknown_phases_and_outcomes_are_dropped() {
    assert_eq!(
        observation(
            r#"{"type":"pi_preparation_timing","phase":"invented_phase","durationMs":1,"outcome":"success"}"#
        ),
        None
    );
    assert_eq!(
        observation(
            r#"{"type":"pi_preparation_timing","phase":"model_runtime","durationMs":1,"outcome":"invented"}"#
        ),
        None
    );
}

#[test]
fn other_stderr_content_is_left_for_the_diagnostic_path() {
    for line in [
        "plain CLI stderr",
        r#"["pi_preparation_timing"]"#,
        r#"{"type":"cli_failure","phase":"model_runtime"}"#,
        r#"{"type":"pi_preparation_timing","phase":"model_runtime"}"#,
        r#"prefix {"type":"pi_preparation_timing","phase":"model_runtime","durationMs":1,"outcome":"success"}"#,
    ] {
        assert_eq!(observation(line), None, "{line}");
    }
}

#[test]
fn unusable_durations_are_dropped() {
    for duration in ["-1", "1e400", "1e30"] {
        let line = format!(
            r#"{{"type":"pi_preparation_timing","phase":"model_runtime","durationMs":{duration},"outcome":"success"}}"#
        );
        assert_eq!(observation(&line), None, "{line}");
    }
}
