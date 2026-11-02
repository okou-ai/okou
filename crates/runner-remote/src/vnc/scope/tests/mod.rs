use super::*;

#[tokio::test]
async fn completed_work_cannot_release_buffered_output_after_same_poll_cancellation() {
    let session = CancellationToken::new();
    let scope = Scope {
        cancelled: CancellationToken::new(),
        sandbox: CancellationToken::new(),
        session: session.clone(),
        native: Vec::new(),
        deadline: Instant::now() + Duration::from_secs(1),
    };
    let result = scope
        .wait(async {
            session.cancel();
            b"buffered output"
        })
        .await;
    assert_eq!(result, Err(Failure::Cancelled));
}

#[tokio::test(start_paused = true)]
async fn deadline_aware_error_wins_when_both_deadlines_are_ready() {
    let deadline = Instant::now() + Duration::from_secs(1);
    let scope = Scope {
        cancelled: CancellationToken::new(),
        sandbox: CancellationToken::new(),
        session: CancellationToken::new(),
        native: Vec::new(),
        deadline,
    };

    let result = scope
        .wait_deadline_aware(async {
            tokio::time::sleep_until(deadline).await;
            Err::<(), _>("staged timeout")
        })
        .await;

    assert_eq!(result, Ok(Err("staged timeout")));
}
