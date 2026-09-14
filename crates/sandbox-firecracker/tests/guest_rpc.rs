#![cfg(target_os = "linux")]

//! Native vsock bridge regression, explicitly executed by metal CI.

use std::{error::Error, io, path::PathBuf, time::Duration};

use runner_rpc_proto::{Delivery, ErrorCode, Response, ResponseWriter};
use sandbox::{
    EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecTermination, FactoryConfig, ResourceLimits,
    RuntimeConfig, Sandbox, SandboxConfig, SandboxRuntime, SnapshotRef, WorkspaceDriveConfig,
};
use sandbox_firecracker::FirecrackerRuntime;
use serde_json::{Value, json, value::RawValue};

type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires root, KVM, NBD and matching packaged rootfs/snapshot; run by metal CI"]
async fn packaged_helper_completes_over_fresh_restored_and_reused_firecracker() -> TestResult<()> {
    if !nix::unistd::getuid().is_root() {
        return Err(io::Error::other("native guest RPC test requires root").into());
    }
    let base = PathBuf::from(std::env::var("OKOU_TEST_RPC_BASE_DIR")?);
    std::fs::create_dir_all(&base)?;
    let mut runtime = FirecrackerRuntime::new(RuntimeConfig {
        proxy_port: None,
        dns_port: None,
        host_cpu_placement: None,
    })
    .await?;
    let result = exercise_factories(&runtime, base).await;
    runtime.shutdown().await;
    result
}

async fn exercise_factories(runtime: &FirecrackerRuntime, base: PathBuf) -> TestResult<()> {
    for restored in [false, true] {
        let snapshot = if restored {
            Some(SnapshotRef {
                output_dir: PathBuf::from(std::env::var("OKOU_TEST_RPC_SNAPSHOT_DIR")?),
                hash: std::env::var("OKOU_TEST_RPC_SNAPSHOT_HASH")?,
            })
        } else {
            None
        };
        let mut factory = runtime
            .create_factory(FactoryConfig {
                profile: "vm0/rpc-metal".into(),
                binary_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_FIRECRACKER")?),
                kernel_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_KERNEL")?),
                rootfs_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_ROOTFS")?),
                base_dir: base.join(if restored { "restored" } else { "fresh" }),
                snapshot,
            })
            .await?;
        // Match the vm0/default image selected by runner-build in metal CI.
        let created = factory
            .create(SandboxConfig {
                id: sandbox::SandboxId::new_v4(),
                resources: ResourceLimits {
                    cpu_count: 2,
                    memory_mb: 4096,
                },
                device_rate_limits: None,
                workspace_drive: Some(WorkspaceDriveConfig {
                    size_mb: 16384,
                    seed_image: None,
                }),
            })
            .await;
        let result = match created {
            Ok(mut sandbox) => {
                let result = exercise_sandbox(&mut *sandbox).await;
                factory.destroy(sandbox).await;
                result
            }
            Err(error) => Err(error.into()),
        };
        factory.shutdown().await;
        result?;
        println!("RPC_FIRECRACKER_PASS restored={restored}");
    }
    Ok(())
}

async fn exercise_sandbox(sandbox: &mut dyn Sandbox) -> TestResult<()> {
    let run = uuid::Uuid::new_v4().to_string();
    sandbox.bind_run_control(&run)?;
    sandbox.start().await?;
    exercise_requests(sandbox, &run).await?;
    let stale = sandbox
        .guest_rpc(&run)
        .ok_or_else(|| io::Error::other("missing RPC acceptor"))?;
    if sandbox.park().await? != sandbox::SandboxParkOutcome::Reusable {
        return Err(io::Error::other("sandbox could not park after RPC completion").into());
    }
    let next_run = uuid::Uuid::new_v4().to_string();
    sandbox.bind_run_control(&next_run)?;
    sandbox.unpark().await?;
    if tokio::time::timeout(Duration::from_secs(5), stale.accept())
        .await?
        .is_ok()
    {
        return Err(io::Error::other("old Run RPC acceptor survived park/reassignment").into());
    }
    exercise_requests(sandbox, &next_run).await
}

async fn exercise_requests(sandbox: &dyn Sandbox, run: &str) -> TestResult<()> {
    for method in ["fixture.echo", "diagnostic.unknown"] {
        let acceptor = sandbox
            .guest_rpc(run)
            .ok_or_else(|| io::Error::other("missing RPC acceptor"))?;
        let input = serde_json::to_vec(&json!({
            "version": 1, "method": method, "params": {"message": "native vsock"}
        }))?;
        let exec_request = ExecRequest {
            cmd: "/usr/local/bin/runner-rpc-client",
            timeout: Duration::from_secs(10),
            env: &[],
            sudo: false,
            expected_exit_codes: &[],
            stdin_bytes: Some(&input),
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        };
        let guest = sandbox.exec(&exec_request);
        let host = async {
            let mut accepted = acceptor.accept().await?;
            let request = runner_rpc_proto::read_request(&mut accepted.stream).await?;
            if request.method != method || accepted.sandbox_id != sandbox.id() {
                return Err(io::Error::other("unexpected native RPC identity or method"));
            }
            let mut writer = ResponseWriter::new(accepted.stream);
            if request.method == "fixture.echo" {
                writer
                    .send(&Response::Event {
                        data: RawValue::from_string("{\"progress\":1}".into())?,
                    })
                    .await?;
                writer
                    .send(&Response::Result {
                        data: request.params,
                    })
                    .await?;
            } else {
                writer
                    .send(&Response::error(
                        ErrorCode::UnknownMethod,
                        Delivery::NotDispatched,
                    ))
                    .await?;
            }
            // The join retains this writer until the helper exits: response EOF
            // must cross Firecracker without dropping the host stream/reservation.
            Ok::<_, io::Error>(writer)
        };
        let (guest, host) =
            tokio::time::timeout(Duration::from_secs(15), async { tokio::join!(guest, host) })
                .await?;
        let writer = host?;
        let guest = guest?;
        let expected_code = if method == "fixture.echo" { 0 } else { 1 };
        if !matches!(guest.termination, ExecTermination::Exited { exit_code } if exit_code == expected_code)
            || !guest.stderr.is_empty()
        {
            return Err(io::Error::other(format!(
                "helper failed: {:?}: {}",
                guest.termination,
                String::from_utf8_lossy(&guest.stderr)
            ))
            .into());
        }
        let observed: Vec<Value> = guest
            .stdout
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(serde_json::from_slice)
            .collect::<Result<_, _>>()?;
        let expected = if method == "fixture.echo" {
            vec![
                json!({"type":"event","data":{"progress":1}}),
                json!({"type":"result","data":{"message":"native vsock"}}),
            ]
        } else {
            vec![json!({"type":"error","code":"unknown_method","delivery":"not_dispatched"})]
        };
        if observed != expected {
            return Err(
                io::Error::other(format!("unexpected helper response: {observed:?}")).into(),
            );
        }
        drop(writer);
    }
    exercise_stream_request(sandbox, run).await
}

async fn exercise_stream_request(sandbox: &dyn Sandbox, run: &str) -> TestResult<()> {
    use runner_rpc_proto::stream::{Frame, Reader, Writer};

    let acceptor = sandbox
        .guest_rpc(run)
        .ok_or_else(|| io::Error::other("missing streaming RPC acceptor"))?;
    let request =
        runner_rpc_proto::parse_request(br#"{"version":1,"method":"fixture.stream","params":{}}"#)?;
    let expected = [0, 255, 128, 10].repeat(4096);
    let mut input = Vec::new();
    runner_rpc_proto::write_request(&mut input, &request).await?;
    let mut input_writer = Writer::input(&mut input);
    input_writer.send(&Frame::Data(expected.clone())).await?;
    input_writer.send(&Frame::End).await?;
    let exec_request = ExecRequest {
        cmd: "/usr/local/bin/runner-rpc-client --stream",
        timeout: Duration::from_secs(10),
        env: &[],
        sudo: false,
        expected_exit_codes: &[],
        stdin_bytes: Some(&input),
        output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
    };
    let guest = sandbox.exec(&exec_request);
    let host = async {
        let mut accepted = acceptor.accept().await?;
        let received = runner_rpc_proto::read_request(&mut accepted.stream).await?;
        if received.method != "fixture.stream" || accepted.sandbox_id != sandbox.id() {
            return Err(io::Error::other(
                "unexpected streaming RPC identity or method",
            ));
        }
        let mut reader = Reader::input(&mut accepted.stream);
        let mut bytes = Vec::new();
        while let Some(frame) = reader.next().await? {
            match frame {
                Frame::Data(data) => bytes.extend(data),
                Frame::End => (),
                Frame::Control(_) => return Err(io::Error::other("unexpected input control")),
            }
        }
        if bytes != expected {
            return Err(io::Error::other("native streaming upload mismatch"));
        }
        let mut writer = Writer::responses(accepted.stream);
        writer.send(&Frame::Data(bytes)).await?;
        writer.send(&Frame::End).await?;
        writer
            .send(&Frame::Control(Response::Result {
                data: received.params,
            }))
            .await?;
        // Preserve the accepted reservation until guest completion. End cannot
        // substitute for host EOF, including after snapshot restoration.
        Ok::<_, io::Error>(writer)
    };
    let (guest, host) =
        tokio::time::timeout(Duration::from_secs(15), async { tokio::join!(guest, host) }).await?;
    let writer = host?;
    let guest = guest?;
    if !matches!(guest.termination, ExecTermination::Exited { exit_code: 0 })
        || !guest.stderr.is_empty()
        || guest.stdout_truncated
        || guest.stderr_truncated
    {
        return Err(io::Error::other("native streaming helper failed").into());
    }
    let mut reader = Reader::responses(guest.stdout.as_slice());
    let mut bytes = Vec::new();
    let mut completed = false;
    while let Some(frame) = reader.next().await? {
        match frame {
            Frame::Data(data) => bytes.extend(data),
            Frame::End => (),
            Frame::Control(Response::Result { .. }) => completed = true,
            _ => return Err(io::Error::other("unexpected native stream response").into()),
        }
    }
    if bytes != expected || !completed {
        return Err(io::Error::other("native streaming download mismatch").into());
    }
    drop(writer);
    Ok(())
}
