use super::*;

#[tokio::test]
async fn producer_unwind_is_cached_failure_across_observers() {
    let step = Step::new(async {
        std::panic::resume_unwind(Box::new("owned readiness producer failed"));
    });
    assert!(
        step.join()
            .await
            .unwrap_err()
            .to_string()
            .contains("producer panicked")
    );
    assert!(
        step.join()
            .await
            .unwrap_err()
            .to_string()
            .contains("producer panicked")
    );
}
