#![cfg(target_os = "linux")]

//! Manual real-Guest validation, outside the metal CI execution selection.

use std::{
    error::Error,
    io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use sandbox::{
    EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecTermination, FactoryConfig, HomeDriveConfig,
    HomeDriveSeedImage, HomeDriveSpaceReserve, ResourceLimits, RuntimeConfig, Sandbox,
    SandboxConfig, SandboxFactory, SandboxRuntime, SnapshotCreateConfig, SnapshotRef,
};
use sandbox_firecracker::{FactoryPaths, FirecrackerRuntime, SandboxPaths};

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

fn env(name: &str) -> Result<PathBuf> {
    Ok(std::env::var(name)?.into())
}

fn home(seed: Option<PathBuf>) -> HomeDriveConfig {
    HomeDriveConfig {
        size_mb: 24576,
        space_reserve: HomeDriveSpaceReserve::default(),
        seed_image: seed.map(HomeDriveSeedImage::Move),
    }
}

async fn exec(vm: &dyn Sandbox, command: &str) -> Result<()> {
    let result = vm
        .exec(&ExecRequest {
            cmd: command,
            timeout: Duration::from_secs(10),
            env: &[],
            sudo: true,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        })
        .await?;
    if result.termination != (ExecTermination::Exited { exit_code: 0 }) {
        return Err(io::Error::other(format!(
            "Guest command failed: {:?}: {}",
            result.termination,
            String::from_utf8_lossy(&result.stderr)
        ))
        .into());
    }
    Ok(())
}

async fn clone_seed(source: &Path, target: &Path) -> Result<()> {
    let status = tokio::process::Command::new("cp")
        .args(["--reflink=auto", "--sparse=always", "--"])
        .arg(source)
        .arg(target)
        .status()
        .await?;
    if !status.success() {
        return Err(io::Error::other("seed clone failed").into());
    }
    Ok(())
}

async fn start_vm(factory: &dyn SandboxFactory, seed: Option<PathBuf>) -> Result<Box<dyn Sandbox>> {
    let mut vm = factory
        .create(SandboxConfig {
            id: sandbox::SandboxId::new_v4(),
            resources: ResourceLimits {
                cpu_count: 2,
                memory_mb: 4096,
            },
            device_rate_limits: None,
            home_drive: Some(home(seed)),
        })
        .await?;
    let result = async {
        vm.bind_run_control(&uuid::Uuid::new_v4().to_string())?;
        vm.start().await?;
        Result::Ok(())
    }
    .await;
    if let Err(error) = result {
        factory.destroy(vm).await;
        return Err(error);
    }
    Ok(vm)
}

async fn create_template(factory: &dyn SandboxFactory, base: &Path) -> Result<PathBuf> {
    let mut producer = start_vm(factory, None).await?;
    let template = base.join("home-template.ext4");
    let result = async {
        exec(&*producer, "printf cached > /home/user/.home-rebind-cached").await?;
        // A physical immutable seed requires settled Guest writes, not merely
        // stopping the VMM after a buffered write.
        exec(&*producer, "cd /; /usr/bin/umount -- /home/user").await?;
        producer.stop().await?;
        let image = SandboxPaths::new(FactoryPaths::new(base.to_owned()).workspace(producer.id()))
            .home_image();
        clone_seed(&image, &template).await
    }
    .await;
    factory.destroy(producer).await;
    result?;
    Ok(template)
}

async fn run_case(
    factory: &dyn SandboxFactory,
    base: &Path,
    template: &Path,
    restored: bool,
    combined: bool,
    iteration: u32,
) -> Result<()> {
    let seed = base.join("selected-cache.ext4");
    clone_seed(template, &seed).await?;
    // Source cloning and blank warmup are outside measured startup.
    let blank = if combined {
        let mut blank = start_vm(factory, None).await?;
        let result = async {
            exec(&*blank, "printf blank > /home/user/.home-rebind-blank").await?;
            if blank.park().await? != sandbox::SandboxParkOutcome::Reusable {
                return Err(io::Error::other("blank could not park").into());
            }
            Result::Ok(())
        }
        .await;
        if let Err(error) = result {
            factory.destroy(blank).await;
            return Err(error);
        }
        Some(blank)
    } else {
        None
    };
    let started = Instant::now();
    let mut vm = match blank {
        Some(blank) => blank,
        None => start_vm(factory, Some(seed.clone())).await?,
    };
    let result = async {
        let backing = vm
            .backing_process()
            .ok_or_else(|| io::Error::other("missing VMM backing identity"))?
            .identity();
        if combined {
            vm.bind_run_control(&uuid::Uuid::new_v4().to_string())?;
            vm.unpark().await?;
        }
        let rebind_started = Instant::now();
        if combined {
            vm.replace_home_drive(&home(Some(seed))).await?;
        }
        let rebind = rebind_started.elapsed();
        exec(
            &*vm,
            concat!(
                "test \"$(cat /home/user/.home-rebind-cached)\" = cached && ",
                "test ! -e /home/user/.home-rebind-blank && ",
                "printf persisted > /home/user/.home-rebind-written"
            ),
        )
        .await?;
        let elapsed = started.elapsed();
        if vm.backing_process().map(|process| process.identity()) != Some(backing) {
            return Err(io::Error::other("VMM generation changed").into());
        }
        println!(
            "HOME_STARTUP restored={restored} combined={combined} iteration={iteration} startup_us={} rebind_us={}",
            elapsed.as_micros(), rebind.as_micros()
        );
        // Force the new write through a normal filesystem detach before
        // checking the active image again; warm VM memory alone is insufficient.
        exec(&*vm, "cd /; /usr/bin/umount -- /home/user").await?;
        let mounted = vm.mount_home_drive().await?;
        if !sandbox::helper_exec::helper_exec_succeeded(&mounted) {
            return Err(io::Error::other("consumer Home could not remount").into());
        }
        exec(&*vm, "test \"$(cat /home/user/.home-rebind-written)\" = persisted").await?;
        if vm.park().await? != sandbox::SandboxParkOutcome::Reusable {
            return Err(io::Error::other("consumer could not park").into());
        }
        vm.bind_run_control(&uuid::Uuid::new_v4().to_string())?;
        vm.unpark().await?;
        exec(&*vm, "test \"$(cat /home/user/.home-rebind-written)\" = persisted").await
    }
    .await;
    factory.destroy(vm).await;
    result
}

async fn exercise(factory: &dyn SandboxFactory, base: &Path, restored: bool) -> Result<()> {
    let template = create_template(factory, base).await?;
    for iteration in 0..6 {
        // Alternate ordering instead of assigning every warm sample to one path.
        let order = if iteration % 2 == 0 {
            [false, true]
        } else {
            [true, false]
        };
        for combined in order {
            run_case(factory, base, &template, restored, combined, iteration).await?;
        }
    }
    std::fs::remove_file(template)?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "manual local-11 validation: requires root, KVM, NBD and paired test rootfs"]
async fn blank_vm_reuses_cached_home() -> Result<()> {
    let base = env("OKOU_TEST_RPC_BASE_DIR")?;
    std::fs::create_dir_all(&base)?;
    let snapshot_dir = base.join("snapshot");
    let snapshot_id = uuid::Uuid::new_v4().to_string();
    sandbox_firecracker::create_snapshot(SnapshotCreateConfig {
        id: snapshot_id.clone(),
        binary_path: env("OKOU_TEST_RPC_FIRECRACKER")?,
        kernel_path: env("OKOU_TEST_RPC_KERNEL")?,
        rootfs_path: env("OKOU_TEST_RPC_ROOTFS")?,
        output_dir: snapshot_dir.clone(),
        vcpu_count: 2,
        memory_mb: 4096,
        home_disk_mb: 24576,
    })
    .await?;
    let mut runtime = FirecrackerRuntime::new(RuntimeConfig {
        proxy_port: None,
        dns_port: None,
        host_cpu_placement: None,
    })
    .await?;
    let result = async {
        for restored in [false, true] {
            let factory_base = base.join(if restored { "restored" } else { "fresh" });
            let mut factory = runtime
                .create_factory(FactoryConfig {
                    profile: "vm0/home-rebind".into(),
                    binary_path: env("OKOU_TEST_RPC_FIRECRACKER")?,
                    kernel_path: env("OKOU_TEST_RPC_KERNEL")?,
                    rootfs_path: env("OKOU_TEST_RPC_ROOTFS")?,
                    base_dir: factory_base.clone(),
                    home_drive_pressure: None,
                    snapshot: restored.then(|| SnapshotRef {
                        output_dir: snapshot_dir.clone(),
                        hash: snapshot_id.clone(),
                    }),
                })
                .await?;
            let result = exercise(factory.as_ref(), &factory_base, restored).await;
            factory.shutdown().await;
            result?;
        }
        Result::Ok(())
    }
    .await;
    runtime.shutdown().await;
    result
}
