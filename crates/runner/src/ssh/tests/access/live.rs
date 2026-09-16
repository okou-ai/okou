//! Explicit, authorized provider lane. No secrets in arguments or diagnostics.

use async_trait::async_trait;
use russh::keys::{HashAlg, PublicKey};
use serde_json::{Value, json};
use std::{
    io,
    net::SocketAddr,
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};
use tokio::net::TcpStream;

use super::super::super::network::{Network, PublicNetwork};
use super::super::{
    harness::{CONNECTION, Harness, Reply},
    output, sessions, terminal, wait_for,
};

#[derive(Default)]
struct ObservedNetwork(Mutex<Vec<std::net::TcpStream>>);

#[async_trait]
impl Network for ObservedNetwork {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        // Some development hosts synthesize non-public proxy IPs. This explicit
        // fixture accepts independently verified DNS answers for the authorized
        // hostname; the production destination validator still checks every IP.
        if let Some(answers) = std::env::var_os("OKOU_TEST_CF_SSH_DNS_ANSWERS") {
            assert_eq!(host, format!("{}.", required("OKOU_TEST_CF_SSH_HOST")));
            return Ok(answers
                .into_string()
                .unwrap()
                .split(',')
                .map(|ip| SocketAddr::new(ip.parse().unwrap(), port))
                .collect());
        }
        PublicNetwork.resolve(host, port).await
    }

    async fn connect(&self, address: SocketAddr) -> io::Result<TcpStream> {
        let socket = PublicNetwork.connect(address).await?.into_std()?;
        self.0.lock().unwrap().push(socket.try_clone()?);
        TcpStream::from_std(socket)
    }
}

impl ObservedNetwork {
    async fn closed(&self) {
        // A duplicate descriptor stays open here, so EOF proves shutdown of the
        // physical socket rather than merely dropping the logical SSH handle.
        wait_for(|| {
            self.0
                .lock()
                .unwrap()
                .iter()
                .all(|socket| socket.peek(&mut [0]).is_ok_and(|size| size == 0))
        })
        .await;
    }
}

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name} for this authorized provider lane"))
}

fn authority() -> Value {
    let env = zeroize::Zeroizing::new(
        std::fs::read_to_string(required("OKOU_TEST_CF_ENV_FILE")).unwrap(),
    );
    let read = |name: &str| {
        env.lines()
            .filter_map(|line| line.split_once('='))
            .find_map(|(key, value)| (key == name).then(|| value.trim_matches('"').to_owned()))
            .unwrap_or_else(|| panic!("missing {name} in the authorized token file"))
    };
    let host_key = PublicKey::from_openssh(&required("OKOU_TEST_CF_SSH_HOST_KEY")).unwrap();
    let key = zeroize::Zeroizing::new(
        std::fs::read_to_string(required("OKOU_TEST_CF_SSH_KEY_FILE")).unwrap(),
    );
    json!({
        "outcome":"resolved_access", "host":required("OKOU_TEST_CF_SSH_HOST"), "port":443,
        "username":required("OKOU_TEST_CF_SSH_USER"), "generation":7,
        "learnedHostKey":{"algorithm":host_key.algorithm().as_str(),"fingerprint":host_key.fingerprint(HashAlg::Sha256).to_string()},
        "authentication":{"method":"private_key","privateKey":key.as_str(),"passphrase":null},
        "access":{"configId":"a10df3be-c1cd-4d62-b180-4462679acf63","generation":1,
            "clientId":read("CF_ACCESS_CLIENT_ID"),"clientSecret":read("CF_ACCESS_CLIENT_SECRET")}
    })
}

fn invalidate(h: &Harness) {
    h.runtime.ably_message(&ably_subscriber::Message {
        name: Some("ssh-authority-invalidated".into()),
        data: json!({"runId":h.run,"connectionId":CONNECTION}),
        id: None,
        client_id: None,
        timestamp: None,
    });
}

#[tokio::test]
#[ignore = "requires explicitly authorized Cloudflare Service Auth and SSH credential files"]
async fn authorized_provider_exec_idle_session_rejection_and_cleanup() {
    let network = Arc::new(ObservedNetwork::default());
    let mut h = Harness::new(Reply::default()).await;
    h.shutdown().await;
    Arc::get_mut(&mut h.runtime).unwrap().network = network.clone();
    h.restart(h.run).await;
    let resolve = h.resolve(authority()).await;

    for _ in 0..2 {
        let frames = h
            .request(json!({"sshConnectionId":CONNECTION,"command":"printf 'native-access-ok\\n'"}))
            .await;
        assert_eq!(
            terminal(&frames)["type"],
            "finished",
            "{}",
            terminal(&frames)
        );
        assert_eq!(terminal(&frames)["exit"]["code"], 0);
        assert_eq!(output(&frames, "stdout"), b"native-access-ok\n");
    }
    assert_eq!(network.0.lock().unwrap().len(), 1);
    eprintln!("provider: pinned SSH authentication, exec, and idle pool reuse passed");

    let id = sessions::start(&h, json!({"type":"exec","command":"cat"}), false).await;
    sessions::state(&h, &id, "running").await;
    sessions::write(&h, &id, "before-idle\n", false).await;
    let read = sessions::rpc(
        &h,
        "read",
        json!({"sessionId":id,"cursor":0,"waitMs":10000}),
    )
    .await;
    assert_eq!(sessions::bytes(&read), b"before-idle\n");
    // This provider lane intentionally spans the official carrier's 54s ping
    // interval and our 30s SSH keepalive; it is not a timing-based speed claim.
    tokio::time::sleep(Duration::from_secs(65)).await;
    sessions::write(&h, &id, "after-idle\n", true).await;
    sessions::state(&h, &id, "finished").await;
    let read = sessions::rpc(&h, "read", json!({"sessionId":id,"cursor":0})).await;
    assert_eq!(sessions::bytes(&read), b"before-idle\nafter-idle\n");
    assert_eq!(network.0.lock().unwrap().len(), 1);
    eprintln!(
        "provider: 65s quiet Session, bidirectional stdin/output, EOF, and no reconnect passed"
    );

    invalidate(&h);
    network.closed().await;
    resolve.delete_async().await;
    let mut invalid = authority();
    invalid["generation"] = json!(8);
    invalid["access"]["generation"] = json!(2);
    invalid["access"]["clientSecret"] = json!("cfast_intentionally-invalid-acceptance-token");
    let rejected = h.resolve(invalid).await;
    let frames = h
        .request(json!({"sshConnectionId":CONNECTION,"command":"printf must-not-run"}))
        .await;
    assert_eq!(terminal(&frames)["type"], "failed");
    assert_eq!(terminal(&frames)["failure_reason"], "network_failure");
    assert_eq!(terminal(&frames)["effects"], "not_started");
    assert!(output(&frames, "stdout").is_empty());
    assert_eq!(network.0.lock().unwrap().len(), 2);
    network.closed().await;
    rejected.delete_async().await;
    eprintln!(
        "provider: invalid Service Token rejected without SSH command or fallback; sockets closed"
    );

    let mut restored = authority();
    restored["generation"] = json!(9);
    restored["access"]["generation"] = json!(3);
    let _resolve = h.resolve(restored).await;
    // A credential update publishes invalidation in production. Updating the
    // private API fixture alone must not silently replace Run-owned authority.
    invalidate(&h);
    let id = sessions::start(&h, json!({"type":"exec","command":"cat"}), false).await;
    sessions::state(&h, &id, "running").await;
    h.shutdown().await;
    network.closed().await;
    wait_for(|| h.observed.reservations.load(Ordering::SeqCst) == 0).await;
    assert_eq!(network.0.lock().unwrap().len(), 3);
    eprintln!(
        "provider: restored authority and Run shutdown of active Session closed all three sockets"
    );
}
