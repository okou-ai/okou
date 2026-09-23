use sandbox::{ExecResult, ExecTermination, Sandbox};
use sandbox_mock::{GuestStateRestoreTimezoneCall, MockSandbox};
use tracing::Level;
use tracing_subscriber::prelude::*;

use super::super::guest_state::{
    GuestTimezoneSyncOutcome, restore_guest_state, restore_guest_state_with_timezone,
    sync_guest_timezone, try_sync_guest_timezone_intent,
};
use super::support::{CapturedEvent, CapturedEvents, minimal_context, sandbox_exec_error};
use crate::error::RunnerError;
use crate::guest_timezone::GuestTimezoneIntent;
use runner_types::ids::RunId;
use runner_types::types::ExecutionContext;

#[tokio::test]
async fn restore_guest_state_uses_fixed_restore_operation() {
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();

    restore_guest_state(&sandbox, &ctx).await.unwrap();

    let calls = sandbox.guest_state_restore_calls();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].unix_seconds > 0);
    assert!(calls[0].unix_nanoseconds < 1_000_000_000);
    assert_eq!(calls[0].entropy_len, 256);
    assert_eq!(
        calls[0].timezone,
        GuestStateRestoreTimezoneCall::BestEffort("UTC".into())
    );
    assert_eq!(calls[0].timeout, super::super::DEFAULT_EXEC_TIMEOUT);
    assert!(sandbox.exec_calls().is_empty());
}

#[tokio::test]
async fn restore_guest_state_passes_best_effort_timezone_to_fixed_operation() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("Asia/Shanghai".into());

    restore_guest_state(&sandbox, &ctx).await.unwrap();

    let calls = sandbox.guest_state_restore_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].timezone,
        GuestStateRestoreTimezoneCall::BestEffort("Asia/Shanghai".into())
    );
    assert!(sandbox.exec_calls().is_empty());
}

#[tokio::test]
async fn restore_guest_state_with_explicit_timezone_requires_zone_in_fixed_operation() {
    let sandbox = MockSandbox::new("test");

    restore_guest_state_with_timezone(&sandbox, "UTC")
        .await
        .unwrap();

    let calls = sandbox.guest_state_restore_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].timezone,
        GuestStateRestoreTimezoneCall::Required("UTC".into())
    );
}

#[tokio::test]
async fn restore_guest_state_with_explicit_timezone_reports_unavailable_zone() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        Vec::new(),
        b"guest timezone unavailable".to_vec(),
    )));

    let result = restore_guest_state_with_timezone(&sandbox, "Mars/Olympus").await;

    match result {
        Err(RunnerError::Config(message)) => {
            assert!(message.contains("guest timezone \"Mars/Olympus\" is unavailable"));
            assert!(message.contains("/usr/share/zoneinfo/Mars/Olympus"));
        }
        other => panic!("expected unavailable-zone config error, got: {other:?}"),
    }
}

#[tokio::test]
async fn restore_guest_state_with_explicit_timezone_fails_when_application_fails() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        2,
        Vec::new(),
        b"ln failed\nguest timezone sync failed".to_vec(),
    )));

    let result = restore_guest_state_with_timezone(&sandbox, "UTC").await;

    match result {
        Err(RunnerError::Internal(message)) => {
            assert!(message.contains("guest state restore failed (exit code 2)"));
            assert!(message.contains("guest timezone sync failed"));
        }
        other => panic!("expected guest restore failure, got: {other:?}"),
    }
}

#[tokio::test]
async fn restore_guest_state_with_explicit_timezone_rejects_invalid_timezone_before_exec() {
    let sandbox = MockSandbox::new("test");

    let result = restore_guest_state_with_timezone(&sandbox, "UTC;id").await;

    let message = result.unwrap_err().to_string();
    assert!(
        message.contains("invalid timezone")
            && message.contains("non-empty guest zoneinfo name")
            && !message.contains("IANA"),
        "unexpected error: {message}"
    );
    assert!(sandbox.guest_state_restore_calls().is_empty());
}

#[tokio::test]
async fn restore_guest_state_rejects_invalid_timezone_without_extra_exec() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("UTC;id".into());

    restore_guest_state(&sandbox, &ctx).await.unwrap();

    let calls = sandbox.guest_state_restore_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].timezone, GuestStateRestoreTimezoneCall::None);
}

#[tokio::test(flavor = "current_thread")]
async fn restore_guest_state_logs_embedded_timezone_failure_without_failing_restore() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        b"timezone stdout".to_vec(),
        b"ln failed\nguest timezone sync failed".to_vec(),
    )));
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("America/New_York".into());
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();

    restore_guest_state(&sandbox, &ctx).await.unwrap();

    let events = captured.entries();
    let event = events
        .iter()
        .find(|event| {
            event.level == Level::WARN
                && event.fields.get("message").map(String::as_str)
                    == Some("failed to set guest timezone")
        })
        .unwrap_or_else(|| panic!("missing timezone warning; events={events:#?}"));
    let run_id = RunId::from(uuid::Uuid::nil()).to_string();
    assert_eq!(
        event.fields.get("run_id").map(String::as_str),
        Some(run_id.as_str())
    );
    assert_eq!(
        event.fields.get("tz").map(String::as_str),
        Some("America/New_York")
    );
    assert_eq!(
        event.fields.get("termination").map(String::as_str),
        Some("exited")
    );
    assert!(
        event
            .fields
            .get("stderr_excerpt")
            .is_some_and(|value| value.contains("guest timezone sync failed")),
        "event={event:#?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn restore_guest_state_logs_unavailable_best_effort_timezone_without_failing_restore() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        Vec::new(),
        b"guest timezone unavailable".to_vec(),
    )));
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("Mars/Olympus".into());
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();

    restore_guest_state(&sandbox, &ctx).await.unwrap();

    let events = captured.entries();
    let event = events
        .iter()
        .find(|event| {
            event.level == Level::WARN
                && event.fields.get("message").map(String::as_str)
                    == Some("failed to set guest timezone")
        })
        .unwrap_or_else(|| panic!("missing timezone warning; events={events:#?}"));
    let run_id = RunId::from(uuid::Uuid::nil()).to_string();
    assert_eq!(
        event.fields.get("run_id").map(String::as_str),
        Some(run_id.as_str())
    );
    assert_eq!(
        event.fields.get("tz").map(String::as_str),
        Some("Mars/Olympus")
    );
    assert_eq!(
        event.fields.get("termination").map(String::as_str),
        Some("exited")
    );
    assert!(
        event
            .fields
            .get("stderr_excerpt")
            .is_some_and(|value| value.contains("guest timezone unavailable")),
        "event={event:#?}"
    );
}

#[tokio::test]
async fn restore_guest_state_propagates_exec_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Err(sandbox_exec_error("restore failed")));
    let ctx = minimal_context();

    let result = restore_guest_state(&sandbox, &ctx);

    assert!(result.await.is_err());
}

#[tokio::test]
async fn restore_guest_state_fails_on_non_exited_result() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult {
        termination: ExecTermination::WaitFailed,
        guest_duration_ms: None,
        stdout: b"restore stdout".to_vec(),
        stderr: b"wait failed".to_vec(),
        diagnostic: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }));
    let ctx = minimal_context();

    let result = restore_guest_state(&sandbox, &ctx).await;

    let message = result.unwrap_err().to_string();
    assert!(
        message.contains("guest state restore failed (wait failed)"),
        "got: {message}"
    );
    assert!(
        message.contains("stderr (captured): wait failed"),
        "got: {message}"
    );
    assert!(
        message.contains("stdout (captured): restore stdout"),
        "got: {message}"
    );
}

#[tokio::test]
async fn restore_guest_state_reports_clock_failure_marker() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        2,
        b"date stdout".to_vec(),
        b"guest clock sync failed\ndate stderr".to_vec(),
    )));
    let ctx = minimal_context();

    let result = restore_guest_state(&sandbox, &ctx).await;

    let message = result.unwrap_err().to_string();
    assert!(
        message.contains("guest state restore failed (exit code 2)"),
        "got: {message}"
    );
    assert!(
        message.contains("guest clock sync failed"),
        "got: {message}"
    );
}

#[tokio::test]
async fn restore_guest_state_reports_reseed_failure_marker() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        Vec::new(),
        b"guest-state-restore failed\nRNDRESEEDCRNG failed".to_vec(),
    )));
    let ctx = minimal_context();

    let result = restore_guest_state(&sandbox, &ctx).await;

    let message = result.unwrap_err().to_string();
    assert!(
        message.contains("guest state restore failed (exit code 1)"),
        "got: {message}"
    );
    assert!(
        message.contains("guest-state-restore failed"),
        "got: {message}"
    );
}

#[tokio::test]
async fn sync_guest_timezone_accepts_common_timezone_name_shapes() {
    for tz in [
        "UTC",
        "Etc/GMT+1",
        "Etc/GMT-14",
        "America/Argentina/Buenos_Aires",
    ] {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.user_timezone = Some(tz.into());

        sync_guest_timezone(&sandbox, &ctx).await;

        let calls = sandbox.exec_calls();
        assert_eq!(calls.len(), 1, "timezone {tz:?} should call guest exec");
        assert_eq!(
            calls[0].cmd,
            format!("/sbin/guest-state-restore --sync-timezone {tz}")
        );
        assert!(!calls[0].cmd.contains("/etc/timezone"));
    }
}

#[tokio::test]
async fn try_sync_guest_timezone_preserves_completed_outcomes() {
    for (result, expected) in [
        (
            ExecResult::new(0, Vec::new(), Vec::new()),
            GuestTimezoneSyncOutcome::Applied,
        ),
        (
            ExecResult::new(0, Vec::new(), b"guest timezone unavailable".to_vec()),
            GuestTimezoneSyncOutcome::Unavailable,
        ),
        (
            ExecResult::new(
                0,
                Vec::new(),
                b"guest timezone sync failed: write denied".to_vec(),
            ),
            GuestTimezoneSyncOutcome::Failed,
        ),
        (
            ExecResult::new(2, Vec::new(), b"unexpected helper failure".to_vec()),
            GuestTimezoneSyncOutcome::Failed,
        ),
    ] {
        let sandbox = MockSandbox::new("test");
        sandbox.push_exec_result(Ok(result));
        let intent = GuestTimezoneIntent::Configured("Asia/Shanghai".into());

        let outcome =
            try_sync_guest_timezone_intent(&sandbox, RunId::from(uuid::Uuid::nil()), &intent)
                .await
                .unwrap();

        assert_eq!(outcome, expected);
    }

    let sandbox = MockSandbox::new("test");
    let outcome = try_sync_guest_timezone_intent(
        &sandbox,
        RunId::from(uuid::Uuid::nil()),
        &GuestTimezoneIntent::Unknown,
    )
    .await
    .unwrap();
    assert_eq!(outcome, GuestTimezoneSyncOutcome::NotRequested);
    assert!(sandbox.exec_calls().is_empty());
}

#[tokio::test]
async fn sync_guest_timezone_skips_when_none() {
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    sync_guest_timezone(&sandbox, &ctx).await;

    assert!(sandbox.exec_calls().is_empty());
}

#[tokio::test]
async fn sync_guest_timezone_rejects_invalid_timezone_names() {
    for invalid_tz in [
        "$(rm -rf /)",
        "../UTC",
        "Etc/../UTC",
        "America/New York",
        "UTC;id",
        "UTC'",
    ] {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.user_timezone = Some(invalid_tz.into());

        sync_guest_timezone(&sandbox, &ctx).await;

        assert!(
            sandbox.exec_calls().is_empty(),
            "timezone {invalid_tz:?} should be rejected before guest exec"
        );
    }
}

#[tokio::test]
async fn sync_guest_timezone_empty_string_skips() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.user_timezone = Some(String::new());
    sync_guest_timezone(&sandbox, &ctx).await;

    assert!(sandbox.exec_calls().is_empty());
}

async fn capture_sync_guest_timezone_events(
    sandbox: &dyn Sandbox,
    ctx: &ExecutionContext,
) -> Vec<CapturedEvent> {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();

    sync_guest_timezone(sandbox, ctx).await;

    captured.entries()
}

#[tokio::test(flavor = "current_thread")]
async fn sync_guest_timezone_logs_nonzero_exit() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        2,
        b"timezone stdout".to_vec(),
        b"timezone stderr".to_vec(),
    )));
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("America/New_York".into());

    let events = capture_sync_guest_timezone_events(&sandbox, &ctx).await;
    let event = events
        .iter()
        .find(|event| {
            event.level == Level::WARN
                && event.fields.get("message").map(String::as_str)
                    == Some("failed to set guest timezone")
        })
        .unwrap_or_else(|| panic!("missing timezone warning; events={events:#?}"));
    let run_id = RunId::from(uuid::Uuid::nil()).to_string();
    assert_eq!(
        event.fields.get("run_id").map(String::as_str),
        Some(run_id.as_str())
    );
    assert_eq!(
        event.fields.get("tz").map(String::as_str),
        Some("America/New_York")
    );
    assert_eq!(event.fields.get("exit_code").map(String::as_str), Some("2"));
    assert_eq!(
        event.fields.get("termination").map(String::as_str),
        Some("exited")
    );
    assert!(
        event
            .fields
            .get("stderr_excerpt")
            .is_some_and(|value| value.contains("timezone stderr")),
        "event={event:#?}"
    );
    assert!(
        event
            .fields
            .get("stdout_excerpt")
            .is_some_and(|value| value.contains("timezone stdout")),
        "event={event:#?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn sync_guest_timezone_logs_non_exited_result() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult {
        termination: ExecTermination::StartFailed,
        guest_duration_ms: None,
        stdout: b"timezone stdout".to_vec(),
        stderr: b"start failed".to_vec(),
        diagnostic: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }));
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("America/New_York".into());

    let events = capture_sync_guest_timezone_events(&sandbox, &ctx).await;
    let event = events
        .iter()
        .find(|event| {
            event.level == Level::WARN
                && event.fields.get("message").map(String::as_str)
                    == Some("failed to set guest timezone")
        })
        .unwrap_or_else(|| panic!("missing timezone warning; events={events:#?}"));

    assert_eq!(
        event.fields.get("termination").map(String::as_str),
        Some("start_failed")
    );
    assert_eq!(event.fields.get("exit_code"), None);
    assert!(
        event
            .fields
            .get("stderr_excerpt")
            .is_some_and(|value| value.contains("start failed")),
        "event={event:#?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn sync_guest_timezone_logs_exec_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Err(sandbox_exec_error("vsock disconnected")));
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("America/New_York".into());

    let events = capture_sync_guest_timezone_events(&sandbox, &ctx).await;

    let event = events
        .iter()
        .find(|event| {
            event.level == Level::WARN
                && event.fields.get("message").map(String::as_str)
                    == Some("failed to set guest timezone")
        })
        .unwrap_or_else(|| panic!("missing timezone warning; events={events:#?}"));
    let run_id = RunId::from(uuid::Uuid::nil()).to_string();
    assert_eq!(
        event.fields.get("run_id").map(String::as_str),
        Some(run_id.as_str())
    );
    assert_eq!(
        event.fields.get("tz").map(String::as_str),
        Some("America/New_York")
    );
    assert!(
        event
            .fields
            .get("error")
            .is_some_and(|value| value.contains("vsock disconnected")),
        "event={event:#?}"
    );
}
