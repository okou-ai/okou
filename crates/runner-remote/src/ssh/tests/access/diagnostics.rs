use super::{
    super::{
        harness::{Reply, params},
        terminal,
    },
    credential,
    gateway::{self, Mode, SECRET},
};
use crate::test_fixtures::diagnostic_report;
use serde_json::json;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn opted_access_results_separate_tls_rejection_upgrade_and_interruption() {
    for (mode, cert_host, cause, action) in [
        (
            Mode::Proxy,
            "wrong.example.com",
            "tls",
            "Check the Access gateway certificate",
        ),
        (
            Mode::Response(format!(
                "HTTP/1.1 403 Forbidden\r\nX-Reflected: {SECRET}\r\nContent-Length: 0\r\n\r\n"
            )),
            "ssh.example.com",
            "rejected",
            "Check the Cloudflare Access service token",
        ),
        (
            Mode::Extension,
            "ssh.example.com",
            "protocol",
            "Check the Access WebSocket upgrade",
        ),
        (
            Mode::Text,
            "ssh.example.com",
            "protocol",
            "Check the Access WebSocket upgrade",
        ),
    ] {
        let (mut h, gateway) = gateway::setup(Reply::default(), mode, cert_host).await;
        h.enable_diagnostics().await;
        let _resolve = h.resolve(credential(&h, true, true)).await;
        let mut diagnostic_params = params();
        diagnostic_params["diagnosticText"] = true.into();
        let frames=h.raw(json!({"version":1,"method":"ssh.exec","remaining_ms":60000,"params":diagnostic_params}).to_string()).await;
        let result = terminal(&frames);
        assert_eq!(result["type"], "failed");
        assert_eq!(result["effects"], "not_started");
        let report = &diagnostic_report(result);
        assert_eq!(report["ssh"]["route"], "cloudflare_access");
        assert_eq!(report["ssh"]["access_failure"], cause);
        assert!(result["diagnostic_text"].as_str().unwrap().contains(action));
        assert!(!serde_json::to_string(&frames).unwrap().contains("canary"));
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
        assert!(h.observed.commands.lock().unwrap().is_empty());
        h.shutdown().await;
        super::super::wait_for(|| gateway.observed.closed.load(Ordering::SeqCst) == 1).await;
    }
}
