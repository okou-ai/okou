use std::task::Poll;

use super::*;

use crate::api::test_support::{MockFirecrackerApi, MockResponse};

fn stats(target_pages: u64, actual_pages: u64) -> MockResponse {
    MockResponse::ok_body(
        serde_json::json!({
            "target_mib": target_pages / 256,
            "actual_mib": actual_pages / 256,
            "target_pages": target_pages,
            "actual_pages": actual_pages,
        })
        .to_string(),
    )
}

#[tokio::test]
async fn deflation_requires_exact_zero_target_and_actual_pages() {
    let mut api =
        MockFirecrackerApi::with_responses([stats(0, 512), stats(0, 1), stats(1, 0), stats(0, 0)]);
    let client = ApiClient::new(api.socket_path()).unwrap();
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
    wait_for_unpark_deflation(&client, state_rx, "exact-pages")
        .await
        .unwrap();
    let requests = api.drain_requests();
    assert_eq!(requests.len(), 4);
    for request in requests {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/balloon/statistics");
    }
}

#[tokio::test]
async fn deflation_propagates_statistics_failure() {
    for response in [
        MockResponse::internal_error_raw("failed"),
        MockResponse::ok_body("invalid JSON"),
    ] {
        let mut api = MockFirecrackerApi::repeating(response);
        let client = ApiClient::new(api.socket_path()).unwrap();
        let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
        let error = wait_for_unpark_deflation(&client, state_rx, "failed-stats")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("balloon deflation statistics"));
        assert_eq!(api.drain_requests().len(), 1);
    }
}

#[tokio::test]
async fn deflation_deadline_includes_a_stalled_statistics_request() {
    let mut api = MockFirecrackerApi::with_handler(|_| async {
        std::future::pending::<MockResponse>().await
    });
    let client = ApiClient::new(api.socket_path()).unwrap();
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
    let task =
        tokio::spawn(
            async move { wait_for_unpark_deflation(&client, state_rx, "stalled-stats").await },
        );
    api.next_request().await;
    tokio::time::pause();
    tokio::time::advance(UNPARK_DEFLATION_TIMEOUT).await;
    let error = task.await.unwrap().unwrap_err();
    assert!(error.to_string().contains("within 5 seconds"));
}

async fn assert_deflation_stops_on_terminal_state(terminal: SandboxState) {
    let mut api = MockFirecrackerApi::with_handler(|_| async {
        std::future::pending::<MockResponse>().await
    });
    let client = ApiClient::new(api.socket_path()).unwrap();
    let (state_tx, state_rx) = watch::channel(SandboxState::Running);
    let deflation = wait_for_unpark_deflation(&client, state_rx, "terminal-stats");
    tokio::pin!(deflation);
    let request = tokio::select! {
        biased;
        result = &mut deflation => panic!("deflation completed before statistics request: {result:?}"),
        request = api.next_request() => request,
    };
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, "/balloon/statistics");

    tokio::time::pause();
    assert!(futures_util::poll!(deflation.as_mut()).is_pending());
    state_tx.send(terminal).unwrap();
    let result = futures_util::poll!(deflation.as_mut());
    tokio::time::resume();
    assert!(
        matches!(&result, Poll::Ready(Err(SandboxError::IdleTransition {
                transition: SandboxIdleTransition::Unpark,
                message,
            })) if message == "sandbox stopped during balloon deflation"),
        "deflation should stop on {terminal:?} while its state sender remains alive: {result:?}"
    );
    drop(state_tx);
}

#[tokio::test]
async fn deflation_stops_on_crash_with_live_state_sender() {
    assert_deflation_stops_on_terminal_state(SandboxState::Crashed).await;
}

#[tokio::test]
async fn deflation_stops_on_stop_with_live_state_sender() {
    assert_deflation_stops_on_terminal_state(SandboxState::Stopped).await;
}

#[tokio::test]
async fn deflation_stops_on_closed_state_stream() {
    let mut api = MockFirecrackerApi::with_handler(|_| async {
        std::future::pending::<MockResponse>().await
    });
    let client = ApiClient::new(api.socket_path()).unwrap();
    let (state_tx, state_rx) = watch::channel(SandboxState::Running);
    let deflation = wait_for_unpark_deflation(&client, state_rx, "closed-state-stream");
    tokio::pin!(deflation);
    let request = tokio::select! {
        biased;
        result = &mut deflation => panic!("deflation completed before statistics request: {result:?}"),
        request = api.next_request() => request,
    };
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, "/balloon/statistics");

    tokio::time::pause();
    assert!(futures_util::poll!(deflation.as_mut()).is_pending());
    drop(state_tx);
    let result = futures_util::poll!(deflation.as_mut());
    tokio::time::resume();
    assert!(
        matches!(&result, Poll::Ready(Err(SandboxError::IdleTransition {
                transition: SandboxIdleTransition::Unpark,
                message,
            })) if message == "sandbox stopped during balloon deflation"),
        "deflation should stop when its state stream closes: {result:?}"
    );
}
