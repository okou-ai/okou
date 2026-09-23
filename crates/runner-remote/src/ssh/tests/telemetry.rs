use tracing_subscriber::prelude::*;

#[test]
fn production_filter_rejects_raw_dependency_diagnostics_at_every_level_and_sink() {
    let fmt_sink = tracing_test_support::CapturedEvents::default();
    let axiom_sink = tracing_test_support::CapturedEvents::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::filter::filter_fn(
            super::super::safe_log_metadata,
        ))
        .with(fmt_sink.clone())
        .with(axiom_sink.clone());
    tracing::subscriber::with_default(subscriber, || {
        for target in [
            "russh",
            "russh::client",
            "russh::keys::format",
            "ssh_key::private",
            "ssh_cipher",
            "tungstenite::handshake::client",
            "tokio_tungstenite",
            "rustls::client",
            "tokio_rustls",
        ] {
            for level in [
                log::Level::Error,
                log::Level::Warn,
                log::Level::Info,
                log::Level::Debug,
                log::Level::Trace,
            ] {
                // Exercise the actual log-to-tracing bridge used by russh.
                log::Log::log(
                    &tracing_log::LogTracer::default(),
                    &log::Record::builder()
                        .target(target)
                        .level(level)
                        .args(format_args!(
                            "private-key-canary command-canary peer-error-canary"
                        ))
                        .build(),
                );
            }
        }
        tracing::error!(target:"russh::client", "direct-tracing-canary");
        tracing::info!(
            run_id = "safe-run",
            outcome = "cancelled",
            "SSH execution finished"
        );
        tracing::error!(target:"russh_other", "unrelated target remains visible");
    });
    for sink in [fmt_sink, axiom_sink] {
        let entries = sink.entries();
        assert_eq!(entries.len(), 2);
        assert!(!format!("{entries:?}").contains("canary"));
    }
}
