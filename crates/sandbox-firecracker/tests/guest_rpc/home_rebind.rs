//! Native filesystem proof only; production cache/admission ownership is unchanged.

use std::{
    io,
    path::{Path, PathBuf},
    time::Instant,
};

use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecTermination, Sandbox};
use sandbox_firecracker::{
    ApiClient, ApiError, FactoryPaths, RuntimePaths, SandboxPaths, SockPaths,
};

use super::TestResult;

pub(super) struct Images {
    cached: PathBuf,
    blank: PathBuf,
}

impl Images {
    pub(super) fn new(base: &Path, cached_id: &str, blank_id: &str) -> Self {
        let factory = FactoryPaths::new(base.to_owned());
        Self {
            cached: SandboxPaths::new(factory.workspace(cached_id)).home_image(),
            blank: SandboxPaths::new(factory.workspace(blank_id)).home_image(),
        }
    }
}

pub(super) async fn exercise(sandbox: &dyn Sandbox, images: &Images) -> TestResult<()> {
    let cached_size = tokio::fs::metadata(&images.cached).await?.len();
    let blank_size = tokio::fs::metadata(&images.blank).await?.len();
    if cached_size == 0 || cached_size != blank_size {
        return Err(io::Error::other("native Home images must have equal nonzero sizes").into());
    }
    let backing = sandbox
        .backing_process()
        .ok_or_else(|| io::Error::other("missing Home-switch backing identity"))?;
    let identity = backing.identity();
    let sockets = SockPaths::new(RuntimePaths::new().sock_dir(sandbox.id()));
    let api = ApiClient::new(&sockets.api_sock())?;

    exec(
        sandbox,
        "printf cached > /home/user/.okou-native-home-rebind",
    )
    .await?;
    detach(sandbox).await?;

    // A known HTTP rejection is distinct from an uncertain transport result.
    // Only the former permits remounting the still-selected original image.
    let missing = images.cached.with_file_name("missing-home.ext4");
    match api.patch_drive_path("home", utf8(&missing)?).await {
        Err(ApiError::Http { status: 400, .. }) => {}
        result => {
            return Err(io::Error::other(format!(
                "expected rejected missing Home backend, got {result:?}"
            ))
            .into());
        }
    }
    mount(sandbox).await?;
    exec(
        sandbox,
        "test \"$(cat /home/user/.okou-native-home-rebind)\" = cached",
    )
    .await?;

    switch(sandbox, &api, &images.blank).await?;
    exec(
        sandbox,
        concat!(
            "test ! -e /home/user/.okou-native-home-rebind; ",
            "printf blank > /home/user/.okou-native-home-rebind; ",
            "printf blank-only > /home/user/.okou-native-home-rebind-blank-only"
        ),
    )
    .await?;

    switch(sandbox, &api, &images.cached).await?;
    exec(
        sandbox,
        concat!(
            "test \"$(cat /home/user/.okou-native-home-rebind)\" = cached; ",
            "test ! -e /home/user/.okou-native-home-rebind-blank-only; ",
            "printf after-rebind > /home/user/.okou-native-home-rebind-written"
        ),
    )
    .await?;
    // Switching away and back forces the new write through filesystem detach,
    // rather than proving only that a Guest page-cache read can see it.
    switch(sandbox, &api, &images.blank).await?;
    exec(
        sandbox,
        "test \"$(cat /home/user/.okou-native-home-rebind)\" = blank",
    )
    .await?;
    switch(sandbox, &api, &images.cached).await?;
    verify_cached_home(sandbox).await?;
    if sandbox.backing_process().map(|backing| backing.identity()) != Some(identity) {
        return Err(io::Error::other("Home replacement changed the VMM backing generation").into());
    }
    println!(
        "HOME_REBIND_PASS sandbox={} home_bytes={cached_size}",
        sandbox.id()
    );
    Ok(())
}

pub(super) async fn verify_cached_home(sandbox: &dyn Sandbox) -> TestResult<()> {
    exec(
        sandbox,
        concat!(
            "test \"$(cat /home/user/.okou-native-home-rebind)\" = cached; ",
            "test \"$(cat /home/user/.okou-native-home-rebind-written)\" = after-rebind; ",
            "test ! -e /home/user/.okou-native-home-rebind-blank-only"
        ),
    )
    .await
}

async fn switch(sandbox: &dyn Sandbox, api: &ApiClient, image: &Path) -> TestResult<()> {
    let start = Instant::now();
    detach(sandbox).await?;
    let detached = start.elapsed();
    api.patch_drive_path("home", utf8(image)?).await?;
    let patched = start.elapsed();
    mount(sandbox).await?;
    println!(
        "HOME_REBIND_PHASE sandbox={} detach_us={} patch_us={} mount_us={}",
        sandbox.id(),
        detached.as_micros(),
        (patched - detached).as_micros(),
        (start.elapsed() - patched).as_micros()
    );
    Ok(())
}

async fn detach(sandbox: &dyn Sandbox) -> TestResult<()> {
    // This controlled native fixture has no active workload. A normal umount
    // must succeed; lazy/forced detach would not establish filesystem safety.
    exec(sandbox, "cd /; /usr/bin/umount -- /home/user").await
}

async fn mount(sandbox: &dyn Sandbox) -> TestResult<()> {
    let result = sandbox.mount_home_drive().await?;
    if !sandbox::helper_exec::helper_exec_succeeded(&result) {
        return Err(io::Error::other(format!(
            "Home remount failed: {:?}: {}",
            result.termination,
            String::from_utf8_lossy(&result.stderr)
        ))
        .into());
    }
    Ok(())
}

async fn exec(sandbox: &dyn Sandbox, command: &str) -> TestResult<()> {
    let result = sandbox
        .exec(&ExecRequest {
            cmd: &format!("set -eu; {command}"),
            timeout: std::time::Duration::from_secs(10),
            env: &[],
            sudo: true,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        })
        .await?;
    if result.termination != (ExecTermination::Exited { exit_code: 0 }) {
        return Err(io::Error::other(format!(
            "Home proof command failed: {:?}: {}",
            result.termination,
            String::from_utf8_lossy(&result.stderr)
        ))
        .into());
    }
    Ok(())
}

fn utf8(path: &Path) -> io::Result<&str> {
    path.to_str()
        .ok_or_else(|| io::Error::other("native Home path is not UTF-8"))
}
