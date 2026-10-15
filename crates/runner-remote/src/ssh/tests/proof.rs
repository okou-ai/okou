use super::{
    harness::{Harness, Reply, params},
    terminal,
};
use std::{io, sync::atomic::Ordering, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn corrupt_host_proof_never_pins_or_authenticates_even_with_matching_key_identity() {
    for pinned in [false, true] {
        let mut h = Harness::new(Reply::default()).await;
        h.enable_diagnostics().await;
        let destination = *h.network.target.lock().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        *h.network.target.lock().unwrap() = listener.local_addr().unwrap();
        let proxy = tokio::spawn(async move {
            let (mut client, _) = listener.accept().await?;
            let mut server = tokio::net::TcpStream::connect(destination).await?;
            let (mut client_read, mut client_write) = client.split();
            let (mut server_read, mut server_write) = server.split();
            let upstream = async {
                tokio::io::copy(&mut client_read, &mut server_write).await?;
                server_write.shutdown().await
            };
            let downstream = async {
                loop {
                    let byte = server_read.read_u8().await?;
                    client_write.write_u8(byte).await?;
                    if byte == b'\n' {
                        break;
                    }
                }
                loop {
                    let length = server_read.read_u32().await?;
                    assert!(length <= 256 * 1024);
                    let mut packet = vec![0; length as usize];
                    server_read.read_exact(&mut packet).await?;
                    let is_reply = packet[1] == 31; // SSH_MSG_KEX_ECDH_REPLY
                    if is_reply {
                        let last_signature_byte = packet.len() - usize::from(packet[0]) - 1;
                        packet[last_signature_byte] ^= 1;
                    }
                    client_write.write_u32(length).await?;
                    client_write.write_all(&packet).await?;
                    if is_reply {
                        break;
                    }
                }
                tokio::io::copy(&mut server_read, &mut client_write).await?;
                client_write.shutdown().await
            };
            tokio::try_join!(upstream, downstream)?;
            Ok::<_, io::Error>(())
        });
        let _resolve = h.resolve(h.credential(pinned)).await;
        let pin = h
            .api
            .mock_async(|when, then| {
                when.path(format!("/api/runners/runs/{}/ssh/pin", h.run));
                then.status(200)
                    .json_body(serde_json::json!({"outcome":"pinned","generation":8}));
            })
            .await;
        let frames = h.raw(serde_json::json!({"version":1,"method":"ssh.exec.diagnostics.v2","remaining_ms":60000,"params":params()}).to_string()).await;
        assert_eq!(terminal(&frames)["failure_reason"], "protocol");
        assert_eq!(terminal(&frames)["effects"], "not_started");
        pin.assert_calls_async(0).await;
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
        let stages = terminal(&frames)["diagnostics"]["report"]["ssh"]["stages"]
            .as_array()
            .unwrap();
        for (stage, status) in [
            ("ssh_proof", "failed"),
            ("ssh_trust", "not_reached"),
            ("authentication", "not_reached"),
        ] {
            assert!(
                stages
                    .iter()
                    .any(|entry| entry["stage"] == stage && entry["status"] == status)
            );
        }
        tokio::time::timeout(Duration::from_secs(5), proxy)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
