//! Explicit independent OpenSSH plus TigerVNC acceptance.
//! See `tests/VNC_SSH_INTEROPERABILITY.md`.

use runner_rpc_proto::stream::{Frame, Reader};
use serde_json::{Value, json};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

use super::{
    harness::{CONNECTION, Harness, Reply, TOKEN},
    terminal,
};
use crate::{
    test_fixtures::http::{HttpClientConfig, http_client},
    vnc::VncRuntime,
};

const OPENSSH_PACKAGE_VERSION: &str = "1:9.6p1-3ubuntu13.14";
const TIGERVNC_PACKAGE_VERSION: &str = "1.13.1+dfsg-2build2";

#[derive(Clone, Copy)]
enum Security {
    Vnc,
    Plain,
}

impl Security {
    const fn fixture_name(self) -> &'static str {
        match self {
            Self::Vnc => "X509Vnc",
            Self::Plain => "X509Plain",
        }
    }

    const fn api_name(self) -> &'static str {
        match self {
            Self::Vnc => "x509_vnc",
            Self::Plain => "x509_plain",
        }
    }
}

struct TigerVnc {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    ready: Value,
    _directory: TempDir,
}

impl TigerVnc {
    async fn start(security: Security) -> Self {
        let script = std::env::var_os("RFB_TIGERVNC_FIXTURE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../rfb-client/tests/fixtures/tigervnc.py")
            });
        let directory = tempfile::tempdir().unwrap();
        let mut child = Command::new("/usr/bin/python3")
            .arg(script)
            .arg(directory.path())
            .arg(security.fixture_name())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("run the isolated setup in tests/VNC_SSH_INTEROPERABILITY.md");
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut fixture = Self {
            child,
            input,
            output,
            ready: Value::Null,
            _directory: directory,
        };
        fixture.ready = fixture.read().await;
        assert_eq!(fixture.ready["ready"], true);
        assert_eq!(fixture.ready["version"], TIGERVNC_PACKAGE_VERSION);
        assert_eq!(fixture.ready["security"], security.fixture_name());
        fixture
    }

    async fn read(&mut self) -> Value {
        let mut line = String::new();
        let length =
            tokio::time::timeout(Duration::from_secs(15), self.output.read_line(&mut line))
                .await
                .expect("TigerVNC fixture response deadline")
                .unwrap();
        assert!(length > 0, "TigerVNC fixture exited before replying");
        serde_json::from_str(&line).unwrap()
    }

    async fn stop(mut self) {
        let mut request = serde_json::to_vec(&json!({"command":"stop"})).unwrap();
        request.push(b'\n');
        self.input.write_all(&request).await.unwrap();
        self.input.flush().await.unwrap();
        assert_eq!(self.read().await["stopped"], true);
        assert!(
            tokio::time::timeout(Duration::from_secs(10), self.child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
    }
}

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing {name}; use the documented setup"))
}

fn ssh_credential(password: bool) -> Value {
    let mut value = json!({
        "outcome": if password { "resolved_password" } else { "resolved" },
        "host": "openssh.acceptance.test",
        "port": required("VNC_OPENSSH_PORT").parse::<u16>().unwrap(),
        "username": required("VNC_OPENSSH_USERNAME"),
        "generation": 7,
        "learnedHostKey": {
            "algorithm": required("VNC_OPENSSH_HOST_KEY_ALGORITHM"),
            "fingerprint": required("VNC_OPENSSH_HOST_KEY_FINGERPRINT")
        }
    });
    let object = value.as_object_mut().unwrap();
    if password {
        object.insert("password".into(), json!(required("VNC_OPENSSH_PASSWORD")));
    } else {
        object.insert(
            "privateKey".into(),
            json!(std::fs::read_to_string(required("VNC_OPENSSH_PRIVATE_KEY")).unwrap()),
        );
        object.insert("passphrase".into(), Value::Null);
    }
    value
}

async fn capture(harness: &Harness, session: &str) -> (Value, Vec<u8>) {
    let mut guest = harness.open().await;
    let request = json!({
        "version": 1,
        "method": "vnc.capture",
        "remaining_ms": 60_000,
        "params": {"sessionId": session}
    })
    .to_string();
    guest
        .write_u32(request.len().try_into().unwrap())
        .await
        .unwrap();
    guest.write_all(request.as_bytes()).await.unwrap();
    guest.shutdown().await.unwrap();
    tokio::time::timeout(Duration::from_secs(60), async {
        let mut reader = Reader::responses(guest);
        let mut controls = Vec::new();
        let mut bytes = Vec::new();
        let mut ended = false;
        while let Some(frame) = reader.next().await.unwrap() {
            match frame {
                Frame::Control(response) => controls.push(serde_json::to_value(response).unwrap()),
                Frame::Data(chunk) => bytes.extend(chunk),
                Frame::End => ended = true,
            }
        }
        assert!(ended);
        (terminal(&controls).clone(), bytes)
    })
    .await
    .expect("VNC capture deadline")
}

#[tokio::test]
#[ignore = "requires the pinned disposable OpenSSH/TigerVNC host setup"]
async fn pinned_openssh_tigervnc_vnc_transport_acceptance() {
    assert_eq!(required("VNC_OPENSSH_VERSION"), OPENSSH_PACKAGE_VERSION);
    tokio::time::timeout(Duration::from_secs(240), async {
        for password in [true, false] {
            for security in [Security::Vnc, Security::Plain] {
                run_case(password, security).await;
            }
        }
    })
    .await
    .expect("OpenSSH plus TigerVNC matrix deadline");
}

async fn run_case(password: bool, security: Security) {
    let fixture = TigerVnc::start(security).await;
    let ssh_port = required("VNC_OPENSSH_PORT").parse::<u16>().unwrap();
    let mut harness = Harness::new(Reply::default()).await;
    *harness.network.target.lock().unwrap() =
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), ssh_port);
    let http = http_client(HttpClientConfig {
        api_url: harness.api.base_url(),
        vercel_bypass: None,
        client_session_id: "openssh-tigervnc-acceptance".into(),
    });
    let vnc = VncRuntime::official(http, TOKEN, harness.identity)
        .unwrap()
        .unwrap();
    harness.restart_with_vnc(Arc::clone(&vnc)).await;

    let ssh_resolve = harness.resolve(ssh_credential(password)).await;
    let authentication = match security {
        Security::Vnc => json!({"method":"vnc_password","password":"testpass"}),
        Security::Plain => json!({
            "method":"username_password",
            "username":required("RFB_TIGERVNC_PLAIN_USERNAME"),
            "password":required("RFB_TIGERVNC_PLAIN_PASSWORD")
        }),
    };
    let vnc_port = fixture.ready["port"].as_u64().unwrap();
    let ca_bundle = std::fs::read_to_string(fixture.ready["ca_pem"].as_str().unwrap()).unwrap();
    let vnc_resolve = harness
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!(
                    "/api/runners/runs/{}/vnc/resolve",
                    harness.run
                ))
                .header("authorization", format!("Bearer {TOKEN}"))
                .json_body(json!({
                    "connectionId":CONNECTION,
                    "runnerIdentity":{
                        "runnerId":harness.identity.runner_id(),
                        "heartbeatGeneration":27
                    },
                    "supportedProfiles":[
                        {"authMethod":"vnc_password","securityType":"x509_vnc","transportType":"direct"},
                        {"authMethod":"username_password","securityType":"x509_plain","transportType":"direct"},
                        {"authMethod":"vnc_password","securityType":"x509_vnc","transportType":"ssh"},
                        {"authMethod":"username_password","securityType":"x509_plain","transportType":"ssh"}
                    ]
                }));
            then.status(200).json_body(json!({
                "outcome":"resolved_transport",
                "host":"127.0.0.1",
                "port":vnc_port,
                "generation":11,
                "serverName":"localhost",
                "transport":{"type":"ssh","connectionId":CONNECTION,"generation":7},
                "authentication":authentication,
                "security":{"type":security.api_name(),"trust":{"mode":"custom_ca","caBundle":ca_bundle}}
            }));
        })
        .await;
    let vnc_check = harness
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/vnc/check", harness.run))
                .header("authorization", format!("Bearer {TOKEN}"))
                .json_body(json!({
                    "connectionId":CONNECTION,
                    "runnerIdentity":{
                        "runnerId":harness.identity.runner_id(),
                        "heartbeatGeneration":27
                    },
                    "expectedGeneration":11,
                    "expectedTransport":{
                        "type":"ssh",
                        "connectionId":CONNECTION,
                        "generation":7
                    }
                }));
            then.status(200).json_body(json!({"outcome":"valid"}));
        })
        .await;

    let started = harness
        .raw(
            json!({
                "version":1,
                "method":"vnc.session.start",
                "remaining_ms":60_000,
                "params":{"connectionId":CONNECTION,"mode":"shared"}
            })
            .to_string(),
        )
        .await;
    assert_eq!(terminal(&started)["outcome"], "started");
    let session = terminal(&started)["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let status = harness
        .raw(
            json!({
                "version":1,
                "method":"vnc.session.status",
                "remaining_ms":60_000,
                "params":{"sessionId":session}
            })
            .to_string(),
        )
        .await;
    assert_eq!(terminal(&status)["outcome"], "status");
    let (captured, png) = capture(&harness, &session).await;
    assert_eq!(captured["outcome"], "captured");
    assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
    let closed = harness
        .raw(
            json!({
                "version":1,
                "method":"vnc.session.close",
                "remaining_ms":60_000,
                "params":{"sessionId":session}
            })
            .to_string(),
        )
        .await;
    assert_eq!(terminal(&closed)["outcome"], "closed");

    ssh_resolve.assert_calls_async(1).await;
    vnc_resolve.assert_calls_async(1).await;
    assert!(vnc_check.calls_async().await >= 3);
    harness.shutdown().await;
    fixture.stop().await;
}
