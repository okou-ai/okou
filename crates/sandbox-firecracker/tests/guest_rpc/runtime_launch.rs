use super::*;
use sandbox::{ProcessOutputMode, StartAgentProcessRequest, StartProcessRequest};

#[derive(serde::Deserialize)]
struct Peer {
    bootstrap: Vec<Agent>,
    url: String,
}

#[derive(serde::Deserialize)]
struct Agent {
    name: String,
    env: std::collections::BTreeMap<String, String>,
}

pub(super) async fn exercise(sandbox: &dyn Sandbox, run: &str) -> TestResult<()> {
    let path = format!("/tmp/runtime-peer-{}.py", uuid::Uuid::new_v4());
    sandbox
        .write_file(&path, include_bytes!("runtime_launch.py"))
        .await?;
    let mut server = sandbox
        .start_process(&StartProcessRequest {
            cmd: &format!("python3 {path} {run}"),
            timeout: Duration::from_secs(260),
            timeout_is_expected: false,
            start_timeout: Duration::from_secs(15),
            env: &[],
            sudo: true,
            output: ProcessOutputMode::stream_with_stderr_capture(8192),
        })
        .await?;
    let cancel = server.take_cancel_handle();
    let mut receiver = server.take_stdout_receiver();
    let mut drain = None;
    let result: TestResult<()> = async {
        let mut remaining = receiver
            .take()
            .ok_or_else(|| io::Error::other("native peer has no stdout"))?;
        let mut header = Vec::new();
        let peer: Peer = tokio::time::timeout(Duration::from_secs(15), async {
            while !header.contains(&b'\n') {
                let part = remaining
                    .recv()
                    .await
                    .ok_or_else(|| io::Error::other("native peer exited before readiness"))?;
                if part.truncated || header.len() + part.bytes.len() > 64 * 1024 {
                    return Err(io::Error::other("native peer readiness bound"));
                }
                header.extend(part.bytes);
            }
            serde_json::from_slice(&header).map_err(io::Error::other)
        })
        .await??;
        drain = Some(tokio::spawn(async move {
            let mut bytes = Vec::new();
            while let Some(part) = remaining.recv().await {
                if part.truncated || bytes.len() + part.bytes.len() > 64 * 1024 {
                    return Err(io::Error::other("native peer output bound"));
                }
                bytes.extend(part.bytes);
            }
            Ok(bytes)
        }));
        let port = peer.url.strip_prefix("http://127.0.0.1:")
            .ok_or_else(|| io::Error::other("native peer origin"))?.parse::<u16>()?;
        for agent in peer.bootstrap {
            if !matches!(agent.name.as_str(), "claude" | "codex" | "pi") {
                return Err(io::Error::other("unexpected native framework").into());
            }
            filesystem::command(sandbox, &format!("curl -fsS --connect-timeout 2 --max-time 15 -X POST http://127.0.0.1:{port}/begin/{}", agent.name), false).await?;
            let env = agent
                .env
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect::<Vec<_>>();
            let handle = sandbox
                .start_agent_process(&StartAgentProcessRequest {
                    timeout: Duration::from_secs(65),
                    env: &env,
                    output: ProcessOutputMode::Buffered {
                        output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
                    },
                })
                .await?;
            let timing = handle.start_timing();
            let ready = timing
                .ready_at
                .saturating_duration_since(timing.shell_started_at);
            let (process, _control) = handle.into_parts();
            let exit = sandbox
                .wait_process(process, Duration::from_secs(75))
                .await?;
            if !matches!(exit.termination, ExecTermination::Exited { exit_code: 0 }) {
                return Err(io::Error::other(format!(
                    "real {} Agent failed: {:?}; {} {}",
                    agent.name,
                    exit.termination,
                    String::from_utf8_lossy(&exit.stdout),
                    String::from_utf8_lossy(&exit.stderr)
                ))
                .into());
            }
            println!(
                "RUNTIME_AGENT_FIRECRACKER_PASS framework={} ready_us={} duration_ms={:?}",
                agent.name,
                ready.as_micros(),
                exit.guest_duration_ms
            );
        }
        filesystem::command(
            sandbox,
            &format!(
                "curl -fsS --connect-timeout 2 --max-time 15 -X POST http://127.0.0.1:{port}/finish"
            ),
            false,
        )
        .await?;
        Ok(())
    }
    .await;
    if result.is_err()
        && let Some(cancel) = cancel
    {
        let _ = cancel.cancel(Duration::from_secs(5)).await;
    }
    let stopped = sandbox.wait_process(server, Duration::from_secs(15)).await;
    if stopped.is_err()
        && let Some(task) = &drain
    {
        task.abort();
    }
    let drained = if let Some(task) = drain {
        Some(task.await)
    } else {
        None
    };
    let cleanup = filesystem::command(sandbox, &format!("rm -f {path}"), false).await;
    if let Err(error) = result {
        let stderr = stopped
            .as_ref()
            .map(|exit| String::from_utf8_lossy(&exit.stderr).into_owned())
            .unwrap_or_else(|error| error.to_string());
        let stdout = match &drained {
            Some(Ok(Ok(bytes))) => String::from_utf8_lossy(bytes).into_owned(),
            other => format!("{other:?}"),
        };
        return Err(io::Error::other(format!(
            "{error}; native peer stderr={stderr}; stdout={stdout}"
        ))
        .into());
    }
    let stopped = stopped?;
    if !matches!(
        stopped.termination,
        ExecTermination::Exited { exit_code: 0 }
    ) {
        return Err(io::Error::other(format!(
            "native peer failed: {}",
            String::from_utf8_lossy(&stopped.stderr)
        ))
        .into());
    }
    if let Some(bytes) = drained {
        println!(
            "RUNTIME_PAYLOAD_FIRECRACKER_PASS {}",
            String::from_utf8_lossy(&bytes??)
        );
    }
    cleanup?;
    Ok(())
}
