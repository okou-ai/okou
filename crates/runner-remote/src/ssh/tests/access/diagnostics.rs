use super::{
    super::{
        harness::{Reply, params},
        terminal,
    },
    credential,
    gateway::{self, Mode, SECRET},
};
use serde_json::json;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn opted_access_results_separate_tls_rejection_upgrade_and_interruption() {
    for (mode, cert_host, cause, action) in [
        (
            Mode::Proxy,
            "wrong.example.com",
            "tls",
            "check_access_certificate",
        ),
        (
            Mode::Response(format!(
                "HTTP/1.1 403 Forbidden\r\nX-Reflected: {SECRET}\r\nContent-Length: 0\r\n\r\n"
            )),
            "ssh.example.com",
            "rejected",
            "check_access_policy",
        ),
        (
            Mode::Extension,
            "ssh.example.com",
            "protocol",
            "check_access_websocket",
        ),
        (
            Mode::Text,
            "ssh.example.com",
            "protocol",
            "check_access_websocket",
        ),
    ] {
        let (mut h, gateway) = gateway::setup(Reply::default(), mode, cert_host).await;
        h.enable_diagnostics().await;
        let _resolve = h.resolve(credential(&h, true, true)).await;
        let frames=h.raw(json!({"version":1,"method":"ssh.exec.diagnostics.v2","remaining_ms":60000,"params":params()}).to_string()).await;
        let result = terminal(&frames);
        assert_eq!(result["type"], "failed");
        assert_eq!(result["effects"], "not_started");
        let report = &result["diagnostics"]["report"];
        assert_eq!(report["ssh"]["route"], "cloudflare_access");
        assert_eq!(report["ssh"]["access_failure"], cause);
        assert_eq!(report["next_action"], action);
        assert!(!serde_json::to_string(&frames).unwrap().contains("canary"));
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
        assert!(h.observed.commands.lock().unwrap().is_empty());
        h.shutdown().await;
        super::super::wait_for(|| gateway.observed.closed.load(Ordering::SeqCst) == 1).await;
    }
}
