use sandbox_firecracker::api_request_gate::{
    ResponseDisposition, gate_request_with_response_control,
};

use super::*;

#[tokio::test]
async fn real_backend_response_precedes_client_delivery_and_survives_control_loss() {
    for action in [
        None,
        Some(ResponseDisposition::Deliver),
        Some(ResponseDisposition::UnwindAfterDelivery),
    ] {
        let root = tempfile::tempdir().unwrap();
        let front = root.path().join("front.sock");
        let back = root.path().join("back.sock");
        let backend = UnixListener::bind(&back).unwrap();
        let (mut request, mut response, mut producer) = gate_request_with_response_control(
            UnixListener::bind(&front).unwrap(),
            back,
            Transition::Resume,
        );
        let api = ApiClient::new(&front).unwrap();
        let mut client = tokio::spawn(async move { api.resume().await });
        let captured = (&mut request.arrived).await.unwrap();
        assert!(backend.accept().now_or_never().is_none());
        request.release.send(()).unwrap();
        let mut actual = actual_request(&backend, &captured.raw).await.unwrap();
        assert!((&mut response.arrived).now_or_never().is_none());
        actual.write_all(RESPONSE).await.unwrap();
        let receipt = response.arrived.await.unwrap();
        assert_eq!(receipt.request, captured);
        assert_eq!(receipt.status, 204);
        assert_eq!(receipt.raw, RESPONSE);
        assert!((&mut client).now_or_never().is_none());
        assert!(producer.join().now_or_never().is_none());
        if let Some(action) = action {
            response.release.send(action).unwrap();
        } else {
            drop(response.release);
        }
        client.await.unwrap().unwrap();
        if action == Some(ResponseDisposition::UnwindAfterDelivery) {
            assert!(producer.join().await.unwrap_err().producer_panicked());
        } else {
            assert!(matches!(
                producer.join().await.unwrap(),
                RequestOutcome::ResponseDrained {
                    status: 204,
                    delivery: Ok(()),
                    ..
                }
            ));
        }
    }
}
