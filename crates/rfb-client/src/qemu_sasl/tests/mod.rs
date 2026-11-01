use super::*;

#[test]
fn server_cpu_budget_is_checked_before_rsasl() {
    let good = b"r=abcdefgh12345678,s=c2FsdHNhbHRzYWx0,i=4096";
    assert!(validate_server_first(good).is_ok());
    for bad in [
        &b"r=abcdefgh12345678,s=c2FsdHNhbHRzYWx0,i=1000000"[..],
        &b"r=abcdefgh12345678,s=c2FsdHNhbHRzYWx0,i=0"[..],
        &b"r=abcdefgh12345678,s=%,i=4096"[..],
        &b"r=abcdefgh12345678,s=c2FsdHNhbHRzYWx0,i=4096,m=extra"[..],
    ] {
        assert!(matches!(
            validate_server_first(bad),
            Err(Error::InvalidScramExchange)
        ));
    }
}

#[tokio::test]
async fn wire_distinguishes_null_empty_and_bad_padding() {
    let (mut client, mut server) = tokio::io::duplex(100);
    server
        .write_all(&[0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 1])
        .await
        .unwrap();
    let mut count = 0;
    assert!(
        read_blob(&mut client, &mut count)
            .await
            .unwrap()
            .0
            .is_none()
    );
    assert_eq!(
        read_blob(&mut client, &mut count)
            .await
            .unwrap()
            .0
            .unwrap()
            .len(),
        0
    );
    assert!(matches!(
        read_blob(&mut client, &mut count).await,
        Err(Error::InvalidScramExchange)
    ));
}
