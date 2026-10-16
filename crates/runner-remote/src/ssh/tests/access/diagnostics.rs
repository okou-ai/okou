use super::{
    super::{
        harness::{Reply, params},
        terminal,
    },
    credential,
    gateway::{self, Mode, SECRET},
};
use crate::test_fixtures::diagnostic_text;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn access_results_separate_tls_rejection_upgrade_and_interruption() {
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
        let frames = h.request(params()).await;
        let result = terminal(&frames);
        assert_eq!(result["type"], "failed");
        assert_eq!(result["effects"], "not_started");
        let text = diagnostic_text(result);
        assert!(text.contains("- Route: cloudflare access; transport: fresh."));
        assert!(text.contains(&format!("- First Cloudflare Access failure: {cause}.")));
        assert!(result["diagnostic_text"].as_str().unwrap().contains(action));
        assert!(!serde_json::to_string(&frames).unwrap().contains("canary"));
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
        assert!(h.observed.commands.lock().unwrap().is_empty());
        h.shutdown().await;
        super::super::wait_for(|| gateway.observed.closed.load(Ordering::SeqCst) == 1).await;
    }
}
