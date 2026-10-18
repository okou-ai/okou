#![cfg(target_os = "linux")]

//! Native vsock bridge regression, explicitly executed by metal CI.

use std::{error::Error, io, path::PathBuf, time::Duration};

use runner_remote::guest_duplex::RunGuestChannels;
use runner_rpc_proto::{Delivery, ErrorCode, Response, ResponseWriter};
use sandbox::{
    EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecTermination, FactoryConfig, HomeDriveConfig,
    ResourceLimits, RuntimeConfig, Sandbox, SandboxConfig, SandboxRuntime, SnapshotRef,
};
use sandbox_firecracker::FirecrackerRuntime;
use serde_json::{Value, json, value::RawValue};

type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

mod duplex;
mod file_read;
mod filesystem;
mod runtime_backing;
mod runtime_launch;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "prepares a new snapshot from an explicitly supplied, owned native image pair"]
async fn prepare_packaged_runtime_snapshot() -> TestResult<()> {
    let output = PathBuf::from(std::env::var("OKOU_TEST_RPC_SNAPSHOT_DIR")?);
    if !nix::unistd::getuid().is_root() || output.exists() {
        return Err(
            io::Error::other("snapshot preparation needs root and a new output directory").into(),
        );
    }
    sandbox_firecracker::create_snapshot(sandbox::SnapshotCreateConfig {
        id: std::env::var("OKOU_TEST_RPC_SNAPSHOT_HASH")?,
        binary_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_FIRECRACKER")?),
        kernel_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_KERNEL")?),
        rootfs_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_ROOTFS")?),
        runtime_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_RUNTIME")?),
        output_dir: output,
        vcpu_count: 2,
        memory_mb: 4096,
        home_disk_mb: 16384,
    })
    .await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires root, KVM, NBD and matching packaged rootfs/snapshot; run by metal CI"]
async fn packaged_helper_completes_over_fresh_restored_and_reused_firecracker() -> TestResult<()> {
    native_scenario(false).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires root, KVM, NBD and the paired real Agent payloads; run by metal CI"]
async fn packaged_runtime_executes_real_agents_tools_and_children() -> TestResult<()> {
    native_scenario(true).await
}

async fn native_scenario(payload: bool) -> TestResult<()> {
    if !nix::unistd::getuid().is_root() {
        return Err(io::Error::other("native guest RPC test requires root").into());
    }
    let base = PathBuf::from(std::env::var("OKOU_TEST_RPC_BASE_DIR")?).join(if payload {
        "payload"
    } else {
        "rpc"
    });
    std::fs::create_dir_all(&base)?;
    let mut runtime = FirecrackerRuntime::new(RuntimeConfig {
        proxy_port: None,
        dns_port: None,
        host_cpu_placement: None,
    })
    .await?;
    let result = async {
        exercise_factories(&runtime, base.clone(), payload).await?;
        if payload {
            exercise_without_home(&runtime, base.join("without-home")).await?;
        }
        Ok(())
    }
    .await;
    runtime.shutdown().await;
    result
}

async fn exercise_without_home(runtime: &FirecrackerRuntime, base: PathBuf) -> TestResult<()> {
    let mut factory = runtime
        .create_factory(FactoryConfig {
            home_drive_pressure: None,
            profile: "vm0/runtime-no-home".into(),
            binary_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_FIRECRACKER")?),
            kernel_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_KERNEL")?),
            rootfs_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_ROOTFS")?),
            runtime_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_RUNTIME")?),
            base_dir: base,
            snapshot: None,
        })
        .await?;
    let result = match factory
        .create(SandboxConfig {
            id: sandbox::SandboxId::new_v4(),
            resources: ResourceLimits {
                cpu_count: 2,
                memory_mb: 4096,
            },
            device_rate_limits: None,
            home_drive: None,
        })
        .await
    {
        Ok(mut sandbox) => {
            let result = exercise_runtime_payload(&mut *sandbox, false).await;
            factory.destroy(sandbox).await;
            result
        }
        Err(error) => Err(error.into()),
    };
    factory.shutdown().await;
    result
}

async fn exercise_factories(
    runtime: &FirecrackerRuntime,
    base: PathBuf,
    payload: bool,
) -> TestResult<()> {
    for restored in [false, true] {
        let snapshot = if restored {
            Some(SnapshotRef {
                output_dir: PathBuf::from(std::env::var("OKOU_TEST_RPC_SNAPSHOT_DIR")?),
                hash: std::env::var("OKOU_TEST_RPC_SNAPSHOT_HASH")?,
            })
        } else {
            None
        };
        let config = FactoryConfig {
            home_drive_pressure: None,
            profile: "vm0/rpc-metal".into(),
            binary_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_FIRECRACKER")?),
            kernel_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_KERNEL")?),
            rootfs_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_ROOTFS")?),
            runtime_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_RUNTIME")?),
            base_dir: base.join(if restored { "restored" } else { "fresh" }),
            snapshot,
        };
        if restored && payload {
            exercise_replaced_runtime_source(runtime, &config).await?;
        }
        let mut factory = runtime.create_factory(config).await?;
        // Match the vm0/default image selected by runner-test-prepare in metal CI.
        let created = factory
            .create(SandboxConfig {
                id: sandbox::SandboxId::new_v4(),
                resources: ResourceLimits {
                    cpu_count: 2,
                    memory_mb: 4096,
                },
                device_rate_limits: None,
                home_drive: Some(HomeDriveConfig {
                    space_reserve: sandbox::HomeDriveSpaceReserve::default(),
                    size_mb: 16384,
                    seed_image: None,
                }),
            })
            .await;
        let result = match created {
            Ok(mut sandbox) => {
                let result = if payload {
                    exercise_runtime_payload(&mut *sandbox, true).await
                } else {
                    exercise_sandbox(&mut *sandbox).await
                };
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

async fn exercise_replaced_runtime_source(
    runtime: &FirecrackerRuntime,
    config: &FactoryConfig,
) -> TestResult<()> {
    let directory = tempfile::tempdir()?;
    let replacement = directory.path().join("runtime.ext4");
    std::fs::copy(&config.runtime_path, &replacement)?;
    let changed = FactoryConfig {
        runtime_path: replacement,
        ..config.clone()
    };
    match runtime.create_factory(changed).await {
        Ok(mut factory) => {
            factory.shutdown().await;
            return Err(io::Error::other("restore accepted a replaced runtime source").into());
        }
        Err(error) => {
            if !error
                .to_string()
                .contains("snapshot runtime source changed since creation")
            {
                return Err(error.into());
            }
        }
    }
    println!("RUNTIME_SOURCE_FIRECRACKER_PASS replaced-generation=rejected-before-restore");
    Ok(())
}

async fn exercise_runtime_payload(
    sandbox: &mut dyn Sandbox,
    home_attached: bool,
) -> TestResult<()> {
    let run = uuid::Uuid::new_v4().to_string();
    sandbox.bind_run_control(&run)?;
    sandbox.start().await?;
    runtime_backing::exercise(sandbox, home_attached).await?;
    runtime_launch::exercise(sandbox, &run).await?;
    if sandbox.park().await? != sandbox::SandboxParkOutcome::Reusable {
        return Err(io::Error::other("runtime payload did not reach reusable park").into());
    }
    let run = uuid::Uuid::new_v4().to_string();
    sandbox.bind_run_control(&run)?;
    sandbox.unpark().await?;
    runtime_backing::exercise(sandbox, home_attached).await?;
    runtime_launch::exercise(sandbox, &run).await
}

async fn exercise_sandbox(sandbox: &mut dyn Sandbox) -> TestResult<()> {
    let registry = RunGuestChannels::default();
    let run = uuid::Uuid::new_v4().to_string();
    sandbox.bind_run_control(&run)?;
    sandbox.start().await?;
    runtime_backing::exercise(sandbox, true).await?;
    let first_epoch = duplex::exercise(sandbox, &run, &registry, None).await?;
    let retired_handles = first_epoch.handles().clone();
    // The established duplex must not consume or block the independent RPC path.
    exercise_requests(sandbox, &run).await?;
    let stale = sandbox
        .guest_rpc(&run)
        .ok_or_else(|| io::Error::other("missing RPC acceptor"))?;
    let stale_duplex = sandbox
        .guest_duplex(&run)
        .ok_or_else(|| io::Error::other("missing duplex acceptor"))?;
    first_epoch.retire().await?;
    if sandbox.park().await? != sandbox::SandboxParkOutcome::Reusable {
        return Err(io::Error::other("sandbox could not park after RPC completion").into());
    }
    let next_run = uuid::Uuid::new_v4().to_string();
    sandbox.bind_run_control(&next_run)?;
    sandbox.unpark().await?;
    runtime_backing::exercise(sandbox, true).await?;
    if tokio::time::timeout(Duration::from_secs(5), stale.accept())
        .await?
        .is_ok()
    {
        return Err(io::Error::other("old Run RPC acceptor survived park/reassignment").into());
    }
    if tokio::time::timeout(Duration::from_secs(5), stale_duplex.accept())
        .await?
        .is_ok()
    {
        return Err(io::Error::other("old Run duplex acceptor survived park/reassignment").into());
    }
    let next_epoch =
        duplex::exercise(sandbox, &next_run, &registry, Some(&retired_handles)).await?;
    exercise_requests(sandbox, &next_run).await?;
    next_epoch.verify_provider_stop(sandbox).await?;
    println!(
        "DUPLEX_FIRECRACKER_PASS activation=acknowledged schema=1 diagnostics=reverse notice=verified streams=8 recovery=verified reuse=fenced cancellation=idle"
    );
    Ok(())
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
