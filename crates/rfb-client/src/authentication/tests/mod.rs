use super::*;

#[tokio::test(start_paused = true)]
async fn a_pending_phase_never_repolls_ready_secret_output_at_its_deadline() {
    use std::{task::Poll, time::Duration};
    let (mut output, mut peer) = tokio::io::duplex(16);
    let (released, gate) = tokio::sync::oneshot::channel();
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut authentication = Box::pin(phase(
        AuthenticationStage::QemuGssapiAuthentication,
        deadline,
        async move {
            gate.await.unwrap();
            output.write_u8(1).await?;
            Ok(())
        },
    ));
    // Arm both the real phase timer and the external authority/IO gate.
    std::future::poll_fn(|cx| {
        assert!(authentication.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    tokio::time::advance(Duration::from_secs(1)).await;
    released.send(()).unwrap();
    let result = authentication.as_mut().await;
    drop(authentication);
    assert!(matches!(
        result,
        Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::QemuGssapiAuthentication
        })
    ));
    // An error returned after sending the byte would not enforce expiry.
    assert_eq!(
        peer.read_u8().await.unwrap_err().kind(),
        std::io::ErrorKind::UnexpectedEof
    );
}

#[tokio::test]
async fn standard_result_never_reinterprets_apple_classic_failure() {
    let (mut client, mut server) = tokio::io::duplex(16);
    server.write_all(&[1, 0, 0, 0]).await.unwrap();
    assert!(matches!(
        read_security_result(&mut client).await,
        Err(Error::InvalidAuthenticationResult)
    ));
}
