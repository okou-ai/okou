//! Subscribe to an Ably channel using an API key.
//!
//! Set `ABLY_API_KEY` with a secret manager or hidden shell prompt; do not put
//! the value in the command itself.
//!
//! ```sh
//! cargo run -p ably-subscriber --example subscribe -- <CHANNEL> [HOST]
//! ```
//!
//! `ABLY_API_KEY` format: `keyName:keySecret` (from your Ably dashboard).
//! Message JSON is printed to stdout, while tracing and status diagnostics are
//! printed to stderr, so stdout can be piped directly to `jq` for formatting.
//! `RUST_LOG` controls tracing verbosity and target filters (INFO by default).
//! Terminal subscription errors produce a nonzero process exit status.

use ably_subscriber::{Error, Event, SubscribeConfig, subscribe};

mod common;

fn init_tracing() -> Result<(), tracing_subscriber::util::TryInitError> {
    use tracing_subscriber::filter::{LevelFilter, Targets};
    use tracing_subscriber::prelude::*;

    // Preserve fmt::init()'s default-feature RUST_LOG behavior while changing its writer.
    let targets = match std::env::var("RUST_LOG") {
        Ok(value) => value.parse::<Targets>().unwrap_or_else(|error| {
            eprintln!("Ignoring `RUST_LOG={value:?}`: {error}");
            Targets::new()
        }),
        Err(std::env::VarError::NotPresent) => {
            Targets::new().with_default(tracing_subscriber::fmt::Subscriber::DEFAULT_MAX_LEVEL)
        }
        Err(error) => {
            eprintln!("Ignoring `RUST_LOG`: {error}");
            Targets::new().with_default(tracing_subscriber::fmt::Subscriber::DEFAULT_MAX_LEVEL)
        }
    };

    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_max_level(LevelFilter::TRACE)
        .finish()
        .with(targets)
        .try_init()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    init_tracing()?;

    const USAGE: &str = "usage: subscribe <CHANNEL> [HOST] (set ABLY_API_KEY; API keys are not accepted as arguments)";
    let api_key = std::env::var("ABLY_API_KEY").map_err(
        |_| "ABLY_API_KEY must be set to keyName:keySecret; API keys are not accepted as arguments",
    )?;
    let mut args = std::env::args().skip(1);
    let channel = args.next().ok_or(USAGE)?;
    let host = args.next();
    if args.next().is_some() {
        return Err(USAGE.into());
    }

    let (key_name, key_secret) = api_key
        .split_once(':')
        .ok_or("ABLY_API_KEY must be in format keyName:keySecret")?;

    let key_name = key_name.to_string();
    let key_secret = key_secret.to_string();

    eprintln!("subscribing to '{channel}' ...");

    let mut config = SubscribeConfig::new(
        Box::new(move || {
            let kn = key_name.clone();
            let ks = key_secret.clone();
            Box::pin(async move { common::create_token_request(&kn, &ks, common::ONE_HOUR_TTL_MS) })
        }),
        channel,
    );
    config.host = host;
    let mut sub = subscribe(config).await?;

    while let Some(event) = sub.next().await {
        match event {
            Event::Message(msg) => {
                eprintln!(
                    "[message] name={} id={} ts={}",
                    msg.name.as_deref().unwrap_or("-"),
                    msg.id.as_deref().unwrap_or("-"),
                    msg.timestamp
                        .map_or_else(|| "-".to_string(), |t| t.to_string()),
                );
                println!("{}", msg.data);
            }
            Event::Connected => eprintln!("[connected]"),
            Event::Disconnected { reason } => {
                eprintln!("[disconnected] {}", reason.as_deref().unwrap_or("-"));
            }
            Event::Error { code, message } => {
                return Err(Error::Protocol { code, message }.into());
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::init_tracing;

    #[test]
    fn tracing_diagnostics_are_separate_from_json_message_output() {
        const CHILD_ENV: &str = "ABLY_SUBSCRIBE_OUTPUT_TEST_CHILD";
        let message = serde_json::json!({"message": "ok"});

        if std::env::var_os(CHILD_ENV).is_some() {
            init_tracing().expect("initialize example tracing");
            tracing::info!(target: "subscribe_output_test", "info diagnostic");
            tracing::debug!(target: "subscribe_output_test", "debug diagnostic");
            println!("{message}");
            return;
        }

        // Each child uses the production initializer and real process streams,
        // isolating both the global subscriber and RUST_LOG from other tests.
        for (rust_log, expect_info, expect_debug, expect_warning) in [
            (None, true, false, false),
            (Some("debug"), true, true, false),
            (Some("off"), false, false, false),
            (Some("subscribe_output_test=debug"), true, true, false),
            (Some("other_target=debug"), false, false, false),
            (Some(""), false, false, false),
            (Some("subscribe_output_test=invalid"), false, false, true),
        ] {
            let mut command = Command::new(std::env::current_exe().expect("test executable"));
            command
                .args([
                    "--exact",
                    "tests::tracing_diagnostics_are_separate_from_json_message_output",
                    "--nocapture",
                    "--quiet",
                ])
                .env(CHILD_ENV, "1")
                .env_remove("RUST_LOG");
            if let Some(rust_log) = rust_log {
                command.env("RUST_LOG", rust_log);
            }

            let output = command.output().expect("run example output probe");
            let stdout = String::from_utf8(output.stdout).expect("stdout is UTF-8");
            let stderr = String::from_utf8(output.stderr).expect("stderr is UTF-8");
            assert!(output.status.success(), "RUST_LOG={rust_log:?}: {stderr}");
            assert!(!stdout.contains("diagnostic"), "{stdout}");
            assert!(!stdout.contains("Ignoring `RUST_LOG"), "{stdout}");

            // The test harness also writes progress to stdout; parse the actual
            // payload line and check diagnostics against the entire stream.
            let payload = stdout
                .lines()
                .find(|line| line.starts_with('{'))
                .expect("JSON message on stdout");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(payload).expect("parse message JSON"),
                message,
            );
            assert_eq!(
                stderr.contains("info diagnostic"),
                expect_info,
                "RUST_LOG={rust_log:?}: {stderr}",
            );
            assert_eq!(
                stderr.contains("debug diagnostic"),
                expect_debug,
                "RUST_LOG={rust_log:?}: {stderr}",
            );
            assert_eq!(
                stderr.contains("Ignoring `RUST_LOG"),
                expect_warning,
                "RUST_LOG={rust_log:?}: {stderr}",
            );
        }
    }
}
