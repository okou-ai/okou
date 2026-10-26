//! Actual immutable driver acceptance; explicit local/native prerequisite owner.

use super::*;
use std::process::Stdio;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};

async fn direct(
    socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    socket
        .send(Message::Text(
            json!({"id":id,"method":method,"params":params})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    loop {
        let value: Value =
            serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap())
                .unwrap();
        if value["id"] == id {
            assert!(value.get("error").is_none());
            return value["result"].clone();
        }
    }
}

async fn driver(namespace: &str, args: &[&str]) -> String {
    let output = tokio::time::timeout(
        Duration::from_secs(45),
        Command::new("/usr/local/bin/agent-browser")
            .args(["--namespace", namespace, "--session", "driver"])
            .args(args)
            .env("AGENT_BROWSER_RESTORE_SAVE", "never")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        output.status.success(),
        "driver {} failed: {}",
        args[0],
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[tokio::test]
#[ignore = "requires the immutable agent-browser 0.38.1-vm0.1 binary and owned Chromium"]
async fn immutable_driver_through_actual_guest_adapter_and_runner_dispatch() {
    let version = Command::new("/usr/local/bin/agent-browser")
        .arg("--version")
        .output()
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&version.stdout).contains("0.38.1-vm0.1"));
    let directory = tempfile::tempdir().unwrap();
    let mut chrome = Command::new("/usr/bin/chromium")
        .args([
            "--headless=new",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--no-default-browser-check",
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0",
        ])
        .arg(format!("--user-data-dir={}", directory.path().display()))
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(chrome.stderr.take().unwrap()).lines();
    let endpoint = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let line = lines.next_line().await.unwrap().unwrap();
            if let Some(url) = line.strip_prefix("DevTools listening on ") {
                return url.to_owned();
            }
        }
    })
    .await
    .unwrap();
    let url = reqwest::Url::parse(&endpoint).unwrap();
    let tcp = tokio::net::TcpStream::connect((
        url.host_str().unwrap(),
        url.port_or_known_default().unwrap(),
    ))
    .await
    .unwrap();
    let mut setup = tokio_tungstenite::client_async(endpoint.clone(), tcp)
        .await
        .unwrap()
        .0;
    let targets = direct(&mut setup, 1, "Target.getTargets", json!({})).await;
    let owned = targets["targetInfos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|info| info["type"] == "page")
        .unwrap()["targetId"]
        .as_str()
        .unwrap()
        .to_owned();
    let window = direct(
        &mut setup,
        2,
        "Browser.getWindowForTarget",
        json!({"targetId":owned}),
    )
    .await["windowId"]
        .as_u64()
        .unwrap();
    let second = direct(
        &mut setup,
        3,
        "Target.createTarget",
        json!({"url":"about:blank"}),
    )
    .await["targetId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        direct(
            &mut setup,
            4,
            "Browser.getWindowForTarget",
            json!({"targetId":second})
        )
        .await["windowId"],
        window
    );
    let foreign = direct(
        &mut setup,
        5,
        "Target.createTarget",
        json!({"url":"data:text/html,<title>Foreign fixture</title>","newWindow":true}),
    )
    .await["targetId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(
        direct(
            &mut setup,
            6,
            "Browser.getWindowForTarget",
            json!({"targetId":foreign})
        )
        .await["windowId"],
        window
    );
    let peer = Peer::relay(endpoint).await;
    let mut harness = Harness::new(&peer).await;
    harness.window = window;
    harness.set_api(true).await;
    let namespace = format!("issue43119-{}", uuid::Uuid::new_v4().simple());
    let address = format!("ws://{}", harness.address);
    use futures_util::FutureExt;
    let outcome = std::panic::AssertUnwindSafe(async {
        driver(&namespace, &["connect", &address]).await;
        driver(
            &namespace,
            &[
                "open",
                "data:text/html,<title>Owned fixture</title><label>Name<input id=name></label>",
            ],
        )
        .await;
        driver(&namespace, &["snapshot"]).await;
        driver(&namespace, &["fill", "#name", "synthetic fixture"]).await;
        driver(&namespace, &["press", "Control+a"]).await;
        driver(&namespace, &["press", "Tab"]).await;
        let image = directory.path().join("capture.png");
        driver(&namespace, &["screenshot", image.to_str().unwrap()]).await;
        assert!(
            tokio::fs::read(&image)
                .await
                .unwrap()
                .starts_with(b"\x89PNG\r\n\x1a\n")
        );
        let tabs = driver(&namespace, &["tab"]).await;
        assert!(!tabs.contains("Foreign fixture") && !tabs.contains(&foreign));
        driver(&namespace, &["tab", "t2"]).await;
        driver(&namespace, &["close"]).await;
        driver(&namespace, &["connect", &address]).await;
        driver(&namespace, &["snapshot"]).await;
        driver(&namespace, &["close"]).await;
    })
    .catch_unwind()
    .await;
    let _ = tokio::time::timeout(
        Duration::from_secs(45),
        Command::new("/usr/local/bin/agent-browser")
            .args(["--namespace", &namespace, "--session", "driver", "close"])
            .env("AGENT_BROWSER_RESTORE_SAVE", "never")
            .kill_on_drop(true)
            .output(),
    )
    .await;
    harness.shutdown().await;
    peer.shutdown().await;
    setup.close(None).await.unwrap();
    chrome.kill().await.unwrap();
    chrome.wait().await.unwrap();
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}
