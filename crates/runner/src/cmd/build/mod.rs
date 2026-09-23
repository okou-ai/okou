use std::fs::File;
use std::path::{Path, PathBuf};

use clap::Args;
use nix::fcntl::Flock;
use sandbox::SnapshotProvider;
use sandbox_firecracker::DNS_PROBE_RESOLVER_IPV4;

use crate::ca;
use crate::config::RootfsSnapshotPathsExt;
use crate::deps::{FIRECRACKER_VERSION, KERNEL_VERSION};
use crate::error::{RunnerError, RunnerResult};
use crate::profile;
use crate::r2_cache::R2ImageCache;
use runner_host::lock;
use runner_host::paths::{HomePaths, RootfsPaths, touch_mtime};

mod guest;
mod hashes;
mod local_publish;
mod okou_cli;
mod scripts;
mod sizes;
mod snapshot;

use guest::{GuestBinaries, guest_definitions};
use hashes::{
    compute_ca_cert_fingerprint, compute_rootfs_build_hashes, compute_snapshot_hash,
    compute_template_hash,
};
use local_publish::LocalFilePublish;
use okou_cli::OkouCliArtifact;
use scripts::{RootfsScriptDir, RootfsScripts, rootfs_script_command, run_rootfs_script};
use sizes::file_sizes;

const TEMPLATE_FILE: &str = "template.ext4";
const TEMPLATE_DOWNLOAD_FILE: &str = "downloaded-template.ext4";
const TEMPLATE_WARM_DIR_PREFIX: &str = "template-warm-";
const TEMPLATE_WARM_ATTEMPT_DIR_PREFIX: &str = "attempt-";
const TEMPLATE_BUILD_DIR_PREFIX: &str = "template-build-";
const TEMPLATE_ATTEMPT_DIR_SUFFIX: &str = ".tmp";

#[derive(Args)]
pub struct BuildArgs {
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-agent binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-agent binary (required)")
    )]
    guest_agent: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-storage-apply binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-storage-apply binary (required)")
    )]
    guest_storage_apply: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-init binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-init binary (required)")
    )]
    guest_init: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to claude-mock binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to claude-mock binary (required)")
    )]
    claude_mock: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to codex-mock binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to codex-mock binary (required)")
    )]
    codex_mock: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-state-restore binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-state-restore binary (required)")
    )]
    guest_state_restore: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-write-file binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-write-file binary (required)")
    )]
    guest_write_file: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-workspace-mount binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-workspace-mount binary (required)")
    )]
    guest_workspace_mount: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-tool-exec binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-tool-exec binary (required)")
    )]
    guest_tool_exec: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to runner-rpc-client binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to runner-rpc-client binary (required)")
    )]
    runner_rpc_client: Option<PathBuf>,
    /// Directory holding a versioned Okou CLI artifact (package.tgz + manifest.json) to install into the rootfs
    #[arg(long, value_name = "DIR", conflicts_with = "warm_rootfs_cache")]
    okou_cli_artifact: Option<PathBuf>,
    /// Profile to build (determines VM resources and disk sizes)
    #[arg(long)]
    pub profile: String,
    /// Print rootfs_hash and snapshot_hash without building (incompatible with --warm-rootfs-cache)
    #[arg(long, conflicts_with = "warm_rootfs_cache")]
    pub dry_run: bool,
    /// Populate only the shared R2 template cache; prints no image hashes (incompatible with --dry-run)
    #[arg(long)]
    pub warm_rootfs_cache: bool,
}

impl BuildArgs {
    fn take_guest_path(&mut self, name: &str) -> Option<PathBuf> {
        match name {
            "guest-agent" => self.guest_agent.take(),
            "guest-storage-apply" => self.guest_storage_apply.take(),
            "guest-init" => self.guest_init.take(),
            "claude-mock" => self.claude_mock.take(),
            "codex-mock" => self.codex_mock.take(),
            "guest-state-restore" => self.guest_state_restore.take(),
            "guest-write-file" => self.guest_write_file.take(),
            "guest-workspace-mount" => self.guest_workspace_mount.take(),
            "guest-tool-exec" => self.guest_tool_exec.take(),
            "runner-rpc-client" => self.runner_rpc_client.take(),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BuildMode {
    FullImage,
    WarmRootfsCache,
}

impl BuildMode {
    fn from_args(args: &BuildArgs) -> Self {
        if args.warm_rootfs_cache {
            Self::WarmRootfsCache
        } else {
            Self::FullImage
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum TemplateCache<'a> {
    Disabled,
    BestEffort(&'a R2ImageCache),
    Required(&'a R2ImageCache),
}

impl<'a> TemplateCache<'a> {
    fn from_optional(mode: BuildMode, cache: Option<&'a R2ImageCache>) -> RunnerResult<Self> {
        match (mode, cache) {
            (BuildMode::FullImage, Some(cache)) => Ok(Self::BestEffort(cache)),
            (BuildMode::WarmRootfsCache, Some(cache)) => Ok(Self::Required(cache)),
            (BuildMode::FullImage, None) => Ok(Self::Disabled),
            (BuildMode::WarmRootfsCache, None) => Err(RunnerError::Internal(
                "--warm-rootfs-cache requires all R2_* template cache environment variables".into(),
            )),
        }
    }

    fn as_cache(self) -> Option<&'a R2ImageCache> {
        match self {
            Self::Disabled => None,
            Self::BestEffort(cache) | Self::Required(cache) => Some(cache),
        }
    }

    fn is_required(self) -> bool {
        matches!(self, Self::Required(_))
    }

    fn is_disabled(self) -> bool {
        matches!(self, Self::Disabled)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TemplateUploadIntent {
    Deduplicated,
    ForceOverwriteInvalidRemote,
}

impl TemplateUploadIntent {
    fn force(self) -> bool {
        matches!(self, Self::ForceOverwriteInvalidRemote)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RemoteTemplateDecision {
    UseDownloaded,
    BuildAndUpload(TemplateUploadIntent),
}

#[derive(Clone, Copy, Debug)]
enum TemplateMaterializationTarget<'a> {
    RootfsStaging(&'a Path),
    RemoteCacheOnly,
}

impl TemplateMaterializationTarget<'_> {
    fn materialize_downloaded(
        self,
        input: &TemplateInput<'_>,
        downloaded_template: &Path,
    ) -> RunnerResult<()> {
        match self {
            Self::RootfsStaging(staging) => {
                move_file_sync(downloaded_template, staging, "materialize template")?;
                tracing::info!(
                    "[OK] template downloaded from R2 into staging: {}",
                    staging.display()
                );
                Ok(())
            }
            Self::RemoteCacheOnly => {
                tracing::info!("[OK] template already in R2: {}", input.template_hash);
                Ok(())
            }
        }
    }

    fn materialize_built(self, built_template: &Path) -> RunnerResult<()> {
        match self {
            Self::RootfsStaging(staging) => {
                move_file_sync(built_template, staging, "move template to staging")
            }
            Self::RemoteCacheOnly => Ok(()),
        }
    }
}

struct TemplateInput<'a> {
    paths: &'a HomePaths,
    template_hash: &'a str,
    cache: TemplateCache<'a>,
    rootfs_disk_mb: u32,
}

struct RootfsBuildInput<'a> {
    template: TemplateInput<'a>,
    rootfs_paths: &'a RootfsPaths,
    guests: &'a GuestBinaries,
    /// Versioned CLI installed into the customize layer; `None` keeps the
    /// legacy commit-addressed `npx` launch path as the only CLI delivery.
    okou_cli: Option<&'a OkouCliArtifact>,
}

enum RootfsImageLock {
    Shared { _guard: Flock<File> },
    Exclusive { guard: std::sync::Arc<Flock<File>> },
}

impl RootfsImageLock {
    #[cfg(test)]
    fn is_exclusive(&self) -> bool {
        matches!(self, Self::Exclusive { .. })
    }

    #[cfg(test)]
    fn is_shared(&self) -> bool {
        matches!(self, Self::Shared { .. })
    }
}

async fn acquire_rootfs_lock_for_image_build(
    paths: &HomePaths,
    rootfs_hash: &str,
    rootfs_paths: &RootfsPaths,
) -> RunnerResult<RootfsImageLock> {
    acquire_rootfs_lock_for_image_build_inner(paths, rootfs_hash, rootfs_paths, || {}).await
}

async fn acquire_rootfs_lock_for_image_build_inner(
    paths: &HomePaths,
    rootfs_hash: &str,
    rootfs_paths: &RootfsPaths,
    mut before_shared_lock: impl FnMut(),
) -> RunnerResult<RootfsImageLock> {
    let rootfs_lock_path = paths.rootfs_lock(rootfs_hash);

    loop {
        if is_rootfs_present(rootfs_paths).await? {
            before_shared_lock();
            tracing::info!(
                "acquiring shared rootfs lock for image build: {}",
                rootfs_lock_path.display()
            );
            let guard = lock::acquire_shared(rootfs_lock_path.clone()).await?;
            if is_rootfs_present(rootfs_paths).await? {
                return Ok(RootfsImageLock::Shared { _guard: guard });
            }
            drop(guard);
            tracing::info!(
                "rootfs disappeared while acquiring shared rootfs lock; retrying image build lock"
            );
            continue;
        }

        tracing::info!(
            "acquiring exclusive rootfs lock for image build: {}",
            rootfs_lock_path.display()
        );
        let guard = lock::acquire(rootfs_lock_path.clone()).await?;
        if is_rootfs_present(rootfs_paths).await? {
            drop(guard);
            tracing::info!(
                "rootfs appeared while acquiring exclusive rootfs lock; retrying with shared lock"
            );
            continue;
        }

        return Ok(RootfsImageLock::Exclusive {
            guard: std::sync::Arc::new(guard),
        });
    }
}

struct BuildHashes {
    template_hash: String,
    rootfs_hash: Option<String>,
    snapshot_hash: Option<String>,
}

struct TemplateLockRelease {
    guard: Option<std::sync::Arc<Flock<File>>>,
    #[cfg(test)]
    callback: Option<Box<dyn FnOnce() + Send>>,
}

impl TemplateLockRelease {
    #[cfg(test)]
    fn none() -> Self {
        Self {
            guard: None,
            callback: None,
        }
    }

    fn from_lock(guard: Flock<File>) -> Self {
        Self {
            guard: Some(std::sync::Arc::new(guard)),
            #[cfg(test)]
            callback: None,
        }
    }

    #[cfg(test)]
    fn from_release(release: impl FnOnce() + Send + 'static) -> Self {
        Self {
            guard: None,
            callback: Some(Box::new(release)),
        }
    }

    fn release(&mut self) {
        self.guard = None;
        #[cfg(test)]
        if let Some(release) = self.callback.take() {
            release();
        }
    }
}

impl Drop for TemplateLockRelease {
    fn drop(&mut self) {
        self.release();
    }
}

/// Build an image (template from R2 cache or local build, snapshot always local).
pub async fn run_build(mut args: BuildArgs, provider: &dyn SnapshotProvider) -> RunnerResult<()> {
    let def = profile::get(&args.profile)?;
    let dry_run = args.dry_run;
    let mode = BuildMode::from_args(&args);
    let paths = HomePaths::new()?;

    let guests = match mode {
        BuildMode::FullImage => Some(GuestBinaries::resolve(&mut args).await?),
        BuildMode::WarmRootfsCache => None,
    };
    let okou_cli = match (mode, args.okou_cli_artifact.take()) {
        (BuildMode::FullImage, Some(dir)) => Some(OkouCliArtifact::resolve(&dir).await?),
        _ => None,
    };

    let hashes = match mode {
        BuildMode::WarmRootfsCache => BuildHashes {
            template_hash: compute_template_hash(def.rootfs_disk_mb),
            rootfs_hash: None,
            snapshot_hash: None,
        },
        BuildMode::FullImage => {
            let guests = guests.as_ref().ok_or_else(|| {
                RunnerError::Internal("full image build missing guest binaries".into())
            })?;
            // Ensure CA exists before hashing the rootfs. The shared template
            // hash deliberately excludes CA, but the local rootfs identity must
            // change if this host's CA changes.
            ca::ensure(&paths).await?;
            let ca_fingerprint = compute_ca_cert_fingerprint(&paths).await?;
            let guest_hash_inputs = guests.hash_inputs();
            let okou_cli_hash_input = okou_cli.as_ref().map(OkouCliArtifact::hash_input);
            let rootfs_hashes = compute_rootfs_build_hashes(
                &guest_hash_inputs,
                &ca_fingerprint,
                def.rootfs_disk_mb,
                okou_cli_hash_input.as_ref(),
            )
            .await?;
            let snapshot_hash = compute_snapshot_hash(
                &rootfs_hashes.rootfs_hash,
                def.vcpu,
                def.memory_mb,
                def.workspace_disk_mb,
                FIRECRACKER_VERSION,
                KERNEL_VERSION,
                &provider.config_hash(),
            );
            BuildHashes {
                template_hash: rootfs_hashes.template_hash,
                rootfs_hash: Some(rootfs_hashes.rootfs_hash),
                snapshot_hash: Some(snapshot_hash),
            }
        }
    };

    tracing::info!(
        template_hash = %hashes.template_hash,
        rootfs_hash = hashes.rootfs_hash.as_deref().unwrap_or("<warm-only>"),
        snapshot_hash = hashes.snapshot_hash.as_deref().unwrap_or("<warm-only>"),
        okou_cli_version = okou_cli
            .as_ref()
            .map(OkouCliArtifact::cli_version)
            .unwrap_or("<none>"),
        "computed build hashes"
    );
    // Machine-readable output consumed by CI workflows and ansible playbooks.
    // Keep stdout limited to config-facing hashes; the internal template
    // hash is already emitted through tracing above.
    if let Some(rootfs_hash) = hashes.rootfs_hash.as_ref() {
        println!("rootfs_hash={rootfs_hash}");
    }
    if let Some(snapshot_hash) = hashes.snapshot_hash.as_ref() {
        println!("snapshot_hash={snapshot_hash}");
    }

    if dry_run {
        return Ok(());
    }

    let rootfs_hash = hashes.rootfs_hash.as_deref();
    let snapshot_hash = hashes.snapshot_hash.as_deref();
    let rootfs_paths = rootfs_hash.map(|hash| RootfsPaths::new(&paths, hash));
    let snapshot_paths = rootfs_paths
        .as_ref()
        .zip(snapshot_hash)
        .map(|(rootfs, hash)| rootfs.snapshot(hash));
    let snapshot_dir = snapshot_paths.as_ref().map(|snapshot| snapshot.dir());

    // Fast path: both rootfs and snapshot already present.
    if let (
        BuildMode::FullImage,
        Some(rootfs_paths),
        Some(snapshot_dir),
        Some(rootfs_hash),
        Some(snapshot_hash),
    ) = (
        mode,
        rootfs_paths.as_ref(),
        snapshot_dir,
        rootfs_hash,
        snapshot_hash,
    ) && is_rootfs_present(rootfs_paths).await?
        && provider.is_complete(snapshot_dir).await.unwrap_or(false)
    {
        let _rootfs_lock = lock::acquire_shared(paths.rootfs_lock(rootfs_hash)).await?;
        let rootfs_still_present = is_rootfs_present(rootfs_paths).await?;
        let _snapshot_lock = lock::acquire_shared(paths.snapshot_lock(snapshot_hash)).await?;
        if rootfs_still_present && provider.is_complete(snapshot_dir).await.unwrap_or(false) {
            tracing::info!(
                "[OK] image already built: rootfs={rootfs_hash}, snapshot={snapshot_hash}"
            );
            touch_mtime(rootfs_paths.dir());
            touch_mtime(snapshot_dir);
            return Ok(());
        }
        tracing::info!(
            "existing image changed while acquiring shared locks; continuing with build"
        );
    }

    // R2 cache init. Fatal on partial config (1-3 of 4 vars set) — better than
    // silently disabling cache for a typo'd secret rotation.
    let r2 = R2ImageCache::from_env()
        .await
        .map_err(|e| RunnerError::Internal(format!("R2 cache init: {e}")))?;
    let template_cache = TemplateCache::from_optional(mode, r2.as_ref())?;
    if template_cache.is_disabled() {
        // Info, not warn — dev environments routinely run without R2 configured.
        tracing::info!("R2 cache disabled (R2_* env vars not set) — skipping download and upload");
    }

    let template_input = TemplateInput {
        paths: &paths,
        template_hash: &hashes.template_hash,
        cache: template_cache,
        rootfs_disk_mb: def.rootfs_disk_mb,
    };

    match mode {
        BuildMode::WarmRootfsCache => {
            let template_lock_path = paths.template_lock(&hashes.template_hash);
            tracing::info!(
                "acquiring exclusive template lock for warm build: {}",
                template_lock_path.display()
            );
            let template_lock = std::sync::Arc::new(lock::acquire(template_lock_path).await?);
            ensure_template_cached_under_lock(&template_input, template_lock).await?;
            tracing::info!(
                "template cache warm complete: template={}",
                hashes.template_hash
            );
            Ok(())
        }

        BuildMode::FullImage => {
            let rootfs_hash = rootfs_hash.ok_or_else(|| {
                RunnerError::Internal("full image build missing rootfs hash".into())
            })?;
            let snapshot_hash = snapshot_hash.ok_or_else(|| {
                RunnerError::Internal("full image build missing snapshot hash".into())
            })?;
            let rootfs_paths = rootfs_paths.as_ref().ok_or_else(|| {
                RunnerError::Internal("full image build missing rootfs paths".into())
            })?;
            let snapshot_dir = snapshot_dir.ok_or_else(|| {
                RunnerError::Internal("full image build missing snapshot dir".into())
            })?;
            let guests = guests.as_ref().ok_or_else(|| {
                RunnerError::Internal("full image build missing guest binaries".into())
            })?;
            // Keep a rootfs lock through snapshot creation so GC cannot reap
            // the rootfs while the snapshot provider is reading it. Existing
            // immutable rootfs images only need a shared lock; exclusive is
            // required only when this process may write `rootfs.ext4`.
            let _rootfs_lock =
                acquire_rootfs_lock_for_image_build(&paths, rootfs_hash, rootfs_paths).await?;
            let input = RootfsBuildInput {
                template: template_input,
                rootfs_paths,
                guests,
                okou_cli: okou_cli.as_ref(),
            };
            if let RootfsImageLock::Exclusive { guard } = &_rootfs_lock {
                let template_lock_path = paths.template_lock(&hashes.template_hash);
                tracing::info!(
                    "acquiring exclusive template lock for image build: {}",
                    template_lock_path.display()
                );
                let template_lock = lock::acquire(template_lock_path).await?;
                let release_template_lock = TemplateLockRelease::from_lock(template_lock);
                ensure_rootfs_under_lock(
                    input,
                    release_template_lock,
                    std::sync::Arc::clone(guard),
                )
                .await?;
            } else {
                tracing::info!(
                    "[OK] rootfs already present: {}",
                    rootfs_paths.dir().display()
                );
            }

            let snapshot_lock = lock::acquire(paths.snapshot_lock(snapshot_hash)).await?;
            if provider.is_complete(snapshot_dir).await.unwrap_or(false) {
                tracing::info!(
                    "[OK] image already built: rootfs={rootfs_hash}, snapshot={snapshot_hash}"
                );
                touch_mtime(rootfs_paths.dir());
                touch_mtime(snapshot_dir);
                return Ok(());
            }

            snapshot::build_snapshot(
                &paths,
                rootfs_paths,
                snapshot_hash,
                snapshot_dir,
                def,
                provider,
                snapshot_lock,
            )
            .await?;

            tracing::info!(
                "image creation complete: rootfs={rootfs_hash}, snapshot={snapshot_hash}"
            );
            Ok(())
        }
    }
}

async fn ensure_rootfs_under_lock(
    input: RootfsBuildInput<'_>,
    mut release_template_lock: TemplateLockRelease,
    rootfs_lock: std::sync::Arc<Flock<File>>,
) -> RunnerResult<()> {
    let publish = LocalFilePublish::for_rootfs(input.rootfs_paths);

    // Clear any `rootfs.ext4.staging` residue from a previous crashed or
    // failed build. Holding the rootfs flock means the previous writer has
    // already exited (the script waiter retains the lock through teardown), so any
    // staging file on disk is guaranteed to be stale — never a concurrent
    // writer's work-in-progress. This is the recovery arm of the
    // staging-rename contract; see `RootfsPaths::rootfs_staging`.
    publish.cleanup_stale_staging_best_effort().await;

    let need_rootfs = !is_rootfs_present(input.rootfs_paths).await?;
    let mut scripts = RootfsScripts::new(rootfs_lock, release_template_lock.guard.clone());

    if need_rootfs {
        let result = async {
            obtain_template_to_staging(&input.template, input.rootfs_paths, &mut scripts).await?;
            scripts.release_template_lock();
            release_template_lock.release();
            let work_dir_path = scripts.path().await?;
            customize_rootfs_staging(&input, &work_dir_path).await?;
            verify_rootfs(
                input.rootfs_paths,
                &work_dir_path,
                input.okou_cli.map(OkouCliArtifact::cli_version),
            )
            .await?;
            write_okou_cli_sidecar(input.rootfs_paths, input.okou_cli).await?;
            // Commit the rootfs. Same-filesystem rename is POSIX-atomic, so
            // `rootfs.ext4` only becomes visible once customization and
            // verification have fully succeeded.
            publish.commit().await?;
            tracing::info!("rootfs committed: {}", publish.stable().display());
            Ok(())
        }
        .await;
        publish.finish_after_result(result).await?;
    } else {
        tracing::info!(
            "[OK] rootfs already present: {}",
            input.rootfs_paths.dir().display()
        );
        scripts.release_template_lock();
        release_template_lock.release();
    }

    Ok(())
}

async fn ensure_template_cached_under_lock(
    input: &TemplateInput<'_>,
    template_lock: std::sync::Arc<Flock<File>>,
) -> RunnerResult<()> {
    let mut scripts = RootfsScripts::new(template_lock, None);
    ensure_template_cached_under_lock_with_scripts(input, &mut scripts).await
}

async fn ensure_template_cached_under_lock_with_scripts(
    input: &TemplateInput<'_>,
    scripts: &mut RootfsScripts,
) -> RunnerResult<()> {
    let cache = input.cache.as_cache().ok_or_else(|| {
        RunnerError::Internal("--warm-rootfs-cache requires R2 template cache".into())
    })?;

    let warm_parent = template_warm_parent_dir(input.paths, input.template_hash);
    cleanup_template_warm_parent(&warm_parent).await?;
    remove_empty_dir_if_exists(&warm_parent).await?;

    match cache.template_exists(input.template_hash).await {
        Ok(true) => {
            tracing::info!("[OK] template already in R2: {}", input.template_hash);
            return Ok(());
        }
        Ok(false) => {
            tracing::info!(
                "R2 template cache miss for {} — building locally",
                input.template_hash
            );
        }
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "R2 template HEAD failed while warming cache: {e}"
            )));
        }
    }

    let work_dir_path = scripts.path().await?;
    // Keep warm-up staging on the runner image volume, not the system temp
    // filesystem. A cache miss builds a full template image before uploading,
    // and /tmp may be much smaller than the runner data disk.
    let warm_dir = template_attempt_dir(&warm_parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX);

    let result = materialize_template_from_r2_or_build(
        input,
        &warm_dir,
        &work_dir_path,
        TemplateMaterializationTarget::RemoteCacheOnly,
    )
    .await;

    finish_template_warm_dir_result(&warm_parent, &warm_dir, result).await
}

fn template_attempt_dir(parent: &Path, prefix: &str) -> PathBuf {
    parent.join(format!(
        "{prefix}{}{TEMPLATE_ATTEMPT_DIR_SUFFIX}",
        uuid::Uuid::new_v4()
    ))
}

fn template_warm_parent_dir(paths: &HomePaths, template_hash: &str) -> PathBuf {
    paths
        .images_dir()
        .join(format!("{TEMPLATE_WARM_DIR_PREFIX}{template_hash}"))
}

fn is_template_attempt_dir_name(name: &str, prefix: &str) -> bool {
    name.starts_with(prefix) && name.ends_with(TEMPLATE_ATTEMPT_DIR_SUFFIX)
}

async fn cleanup_stale_template_attempt_dirs(parent: &Path, prefix: &str) -> RunnerResult<()> {
    let mut entries = match tokio::fs::read_dir(parent).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "read template attempt parent {}: {e}",
                parent.display()
            )));
        }
    };

    while let Some(entry) = entries.next_entry().await.map_err(|e| {
        RunnerError::Internal(format!(
            "read template attempt entry in {}: {e}",
            parent.display()
        ))
    })? {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if is_template_attempt_dir_name(name, prefix) {
            remove_path_if_exists(&entry.path(), "stale template attempt dir").await?;
        }
    }

    Ok(())
}

async fn cleanup_template_warm_parent(parent: &Path) -> RunnerResult<()> {
    match tokio::fs::symlink_metadata(parent).await {
        Ok(metadata) if metadata.is_dir() => {
            cleanup_stale_template_attempt_dirs(parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX).await
        }
        Ok(_) => remove_path_if_exists(parent, "stale template warm parent").await,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(RunnerError::Internal(format!(
            "stat template warm parent {}: {e}",
            parent.display()
        ))),
    }
}

async fn remove_path_if_exists(path: &Path, label: &str) -> RunnerResult<()> {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => Err(RunnerError::Internal(format!(
            "stat {label} {}: {e}",
            path.display()
        )))?,
    };

    let result = if metadata.is_dir() {
        tokio::fs::remove_dir_all(path).await
    } else {
        tokio::fs::remove_file(path).await
    };
    result.map_err(|e| RunnerError::Internal(format!("remove {label} {}: {e}", path.display())))
}

async fn remove_dir_all_if_exists(path: &Path, label: &str) -> RunnerResult<()> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(RunnerError::Internal(format!(
            "remove {label} {}: {e}",
            path.display()
        ))),
    }
}

async fn finish_temp_dir_result(
    path: &Path,
    label: &str,
    result: RunnerResult<()>,
) -> RunnerResult<()> {
    let cleanup = remove_dir_all_if_exists(path, label).await;
    match (result, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Ok(()), Err(cleanup_err)) => Err(cleanup_err),
        (Err(original_err), Ok(())) => Err(original_err),
        (Err(original_err), Err(cleanup_err)) => {
            tracing::warn!(
                "failed to remove {label} {} after an earlier error: {cleanup_err}",
                path.display()
            );
            Err(original_err)
        }
    }
}

async fn finish_template_warm_dir_result(
    parent: &Path,
    attempt: &Path,
    result: RunnerResult<()>,
) -> RunnerResult<()> {
    let result = finish_temp_dir_result(attempt, "template warm dir", result).await;
    match remove_empty_dir_if_exists(parent).await {
        Ok(()) => result,
        Err(parent_err) => match result {
            Ok(()) => Err(parent_err),
            Err(original_err) => {
                tracing::warn!(
                    "failed to remove template warm parent {} after an earlier error: {parent_err}",
                    parent.display()
                );
                Err(original_err)
            }
        },
    }
}

async fn remove_empty_dir_if_exists(path: &Path) -> RunnerResult<()> {
    match tokio::fs::remove_dir(path).await {
        Ok(()) => Ok(()),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(e) => Err(RunnerError::Internal(format!(
            "remove empty template warm parent {}: {e}",
            path.display()
        ))),
    }
}

async fn obtain_template_to_staging(
    input: &TemplateInput<'_>,
    rootfs_paths: &RootfsPaths,
    scripts: &mut RootfsScripts,
) -> RunnerResult<()> {
    let staging = rootfs_paths.rootfs_staging();
    cleanup_stale_template_attempt_dirs(rootfs_paths.dir(), TEMPLATE_BUILD_DIR_PREFIX).await?;
    let attempt_dir = template_attempt_dir(rootfs_paths.dir(), TEMPLATE_BUILD_DIR_PREFIX);

    let result = async {
        let work_dir_path = scripts.path().await?;
        materialize_template_from_r2_or_build(
            input,
            &attempt_dir,
            &work_dir_path,
            TemplateMaterializationTarget::RootfsStaging(&staging),
        )
        .await
    }
    .await;

    finish_temp_dir_result(&attempt_dir, "template build dir", result).await
}

async fn materialize_template_from_r2_or_build(
    input: &TemplateInput<'_>,
    attempt_dir: &Path,
    work_dir: &RootfsScriptDir,
    target: TemplateMaterializationTarget<'_>,
) -> RunnerResult<()> {
    tokio::fs::create_dir_all(attempt_dir).await.map_err(|e| {
        RunnerError::Internal(format!(
            "create template attempt dir {}: {e}",
            attempt_dir.display()
        ))
    })?;

    let downloaded_template = attempt_dir.join(TEMPLATE_DOWNLOAD_FILE);
    match resolve_remote_template(input, &downloaded_template, work_dir).await? {
        RemoteTemplateDecision::UseDownloaded => {
            target.materialize_downloaded(input, &downloaded_template)
        }
        RemoteTemplateDecision::BuildAndUpload(upload_intent) => {
            build_template_locally(input, attempt_dir, work_dir).await?;
            let built_template = attempt_dir.join(TEMPLATE_FILE);
            upload_template_to_r2(input, &built_template, upload_intent.force()).await?;
            target.materialize_built(&built_template)
        }
    }
}

async fn resolve_remote_template(
    input: &TemplateInput<'_>,
    downloaded_template: &Path,
    work_dir: &RootfsScriptDir,
) -> RunnerResult<RemoteTemplateDecision> {
    let Some(cache) = input.cache.as_cache() else {
        return Ok(RemoteTemplateDecision::BuildAndUpload(
            TemplateUploadIntent::Deduplicated,
        ));
    };

    let expected_template_bytes = u64::from(input.rootfs_disk_mb) * 1024 * 1024;
    match cache
        .try_download_template_to_file(
            input.template_hash,
            downloaded_template,
            expected_template_bytes,
        )
        .await
    {
        Ok(true) => match verify_template_file(downloaded_template, work_dir).await {
            Ok(()) => Ok(RemoteTemplateDecision::UseDownloaded),
            Err(e) => {
                if input.cache.is_required() {
                    tracing::warn!(
                        "R2 template object for {} failed required-cache validation ({e}) — \
                         rebuilding locally and force-overwriting the bad object",
                        input.template_hash
                    );
                } else {
                    tracing::warn!(
                        "R2 template object for {} failed validation ({e}) — \
                         rebuilding locally and force-overwriting the bad object",
                        input.template_hash
                    );
                }
                Ok(RemoteTemplateDecision::BuildAndUpload(
                    TemplateUploadIntent::ForceOverwriteInvalidRemote,
                ))
            }
        },
        Ok(false) => {
            tracing::info!(
                "R2 template cache miss for {} — building locally",
                input.template_hash
            );
            Ok(RemoteTemplateDecision::BuildAndUpload(
                TemplateUploadIntent::Deduplicated,
            ))
        }
        Err(e) if e.is_invalid_object() => {
            if input.cache.is_required() {
                tracing::warn!(
                    "R2 template object for {} is invalid in required-cache mode ({e}) — \
                     rebuilding locally and force-overwriting the bad object",
                    input.template_hash
                );
            } else {
                tracing::warn!(
                    "R2 template object for {} is invalid ({e}) — \
                     rebuilding locally and force-overwriting the bad object",
                    input.template_hash
                );
            }
            Ok(RemoteTemplateDecision::BuildAndUpload(
                TemplateUploadIntent::ForceOverwriteInvalidRemote,
            ))
        }
        Err(e) if input.cache.is_required() => Err(RunnerError::Internal(format!(
            "R2 template download failed while template cache is required: {e}"
        ))),
        Err(e) => {
            tracing::warn!("R2 template download failed: {e} — falling back to local build");
            Ok(RemoteTemplateDecision::BuildAndUpload(
                TemplateUploadIntent::Deduplicated,
            ))
        }
    }
}

fn move_file_sync(source: &Path, destination: &Path, label: &str) -> RunnerResult<()> {
    std::fs::rename(source, destination).map_err(|e| {
        RunnerError::Internal(format!(
            "{label} {} → {}: {e}",
            source.display(),
            destination.display()
        ))
    })
}

async fn build_template_locally(
    input: &TemplateInput<'_>,
    output_dir: &Path,
    work_dir: &RootfsScriptDir,
) -> RunnerResult<()> {
    tokio::fs::create_dir_all(output_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", output_dir.display())))?;

    // Local template build — the slow path (debootstrap + apt install).
    let debootstrap_dir = input.paths.debootstrap_dir();
    tokio::fs::create_dir_all(&debootstrap_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", debootstrap_dir.display())))?;
    let debootstrap_lock_path = input.paths.debootstrap_lock();
    drop(lock::open_lock_file(&debootstrap_lock_path)?);
    let rootfs_disk_mb_str = input.rootfs_disk_mb.to_string();

    let mut cmd = rootfs_script_command(work_dir, "build-template.sh")?;
    cmd.command
        .arg("--output-dir")
        .arg(output_dir)
        .arg("--debootstrap-dir")
        .arg(&debootstrap_dir)
        .arg("--debootstrap-lock")
        .arg(&debootstrap_lock_path)
        .arg("--hash")
        .arg(input.template_hash)
        .arg("--rootfs-disk-mb")
        .arg(&rootfs_disk_mb_str);
    let status = run_rootfs_script(cmd, "build-template.sh").await?;

    if !status.success() {
        return Err(RunnerError::Internal(format!(
            "build-template.sh failed with {status}"
        )));
    }

    let template = output_dir.join(TEMPLATE_FILE);
    if !tokio::fs::try_exists(&template).await.unwrap_or(false) {
        return Err(RunnerError::Internal(format!(
            "build-template.sh did not create {}",
            template.display()
        )));
    }
    verify_template_file(&template, work_dir).await?;

    let template_sz = file_sizes(&template).await;
    tracing::info!(
        template_logical = %template_sz.0,
        template_disk = %template_sz.1,
        "template creation complete"
    );

    Ok(())
}

async fn verify_rootfs(
    rootfs_paths: &RootfsPaths,
    work_dir: &RootfsScriptDir,
    okou_cli_version: Option<&str>,
) -> RunnerResult<()> {
    verify_rootfs_file(
        &rootfs_paths.rootfs_staging(),
        work_dir,
        "rootfs",
        okou_cli_version,
    )
    .await?;

    let rootfs_sz = file_sizes(&rootfs_paths.rootfs_staging()).await;
    tracing::info!(
        rootfs_logical = %rootfs_sz.0,
        rootfs_disk = %rootfs_sz.1,
        "rootfs verification complete"
    );

    Ok(())
}

async fn verify_template_file(rootfs: &Path, work_dir: &RootfsScriptDir) -> RunnerResult<()> {
    verify_rootfs_file(rootfs, work_dir, "template", None).await?;

    let rootfs_sz = file_sizes(rootfs).await;
    tracing::info!(
        rootfs_logical = %rootfs_sz.0,
        rootfs_disk = %rootfs_sz.1,
        "template verification complete"
    );

    Ok(())
}

async fn verify_rootfs_file(
    rootfs: &Path,
    work_dir: &RootfsScriptDir,
    mode: &str,
    okou_cli_version: Option<&str>,
) -> RunnerResult<()> {
    let mut cmd = rootfs_script_command(work_dir, "verify-rootfs.sh")?;
    cmd.command
        .arg("--rootfs")
        .arg(rootfs)
        .arg("--mode")
        .arg(mode);
    for definition in guest_definitions() {
        cmd.command.arg("--guest-dest").arg(definition.destination);
    }
    if let Some(version) = okou_cli_version {
        cmd.command.arg("--okou-cli-version").arg(version);
    }
    let status = run_rootfs_script(cmd, "verify-rootfs.sh").await?;

    if !status.success() {
        return Err(RunnerError::Internal(format!(
            "verify-rootfs.sh failed with {status}"
        )));
    }

    Ok(())
}

async fn upload_template_to_r2(
    input: &TemplateInput<'_>,
    rootfs: &Path,
    force: bool,
) -> RunnerResult<()> {
    let (cache, required) = match input.cache {
        TemplateCache::Disabled => return Ok(()),
        TemplateCache::BestEffort(cache) => (cache, false),
        TemplateCache::Required(cache) => (cache, true),
    };

    match cache
        .upload_template(input.template_hash, rootfs, force)
        .await
    {
        Ok(()) => {
            tracing::info!("uploaded template to R2: {}", input.template_hash);
            Ok(())
        }
        Err(e) if required => Err(RunnerError::Internal(format!(
            "R2 upload failed while template cache is required: {e}"
        ))),
        Err(e) => {
            tracing::warn!("R2 upload failed: {e} — template is on local disk");
            Ok(())
        }
    }
}

async fn customize_rootfs_staging(
    input: &RootfsBuildInput<'_>,
    work_dir: &RootfsScriptDir,
) -> RunnerResult<()> {
    let staging = input.rootfs_paths.rootfs_staging();
    let ca_dir = input.template.paths.ca_dir();
    let mut cmd = rootfs_script_command(work_dir, "customize-rootfs.sh")?;
    cmd.command
        .arg("--rootfs")
        .arg(&staging)
        .arg("--ca-dir")
        .arg(&ca_dir)
        .arg("--dns-nameserver")
        .arg(DNS_PROBE_RESOLVER_IPV4.to_string());
    for guest in input.guests.iter() {
        cmd.command
            .arg("--guest")
            .arg(&guest.path)
            .arg(guest.definition.destination);
    }
    if let Some(okou_cli) = input.okou_cli {
        cmd.command
            .arg("--okou-cli")
            .arg(okou_cli.package_path())
            .arg(okou_cli.cli_version())
            .arg(okou_cli.installed_manifest_path());
    }
    let status = run_rootfs_script(cmd, "customize-rootfs.sh").await?;

    if !status.success() {
        return Err(RunnerError::Internal(format!(
            "customize-rootfs.sh failed with {status}"
        )));
    }

    Ok(())
}

/// Publish or clear the installed Okou CLI sidecar for a rootfs about to commit.
///
/// The running service reads this file to advertise the installed versions at
/// claim time; the rootfs hash already covers the same bytes, so a rootfs that
/// is present on disk always has a sidecar that matches its content.
async fn write_okou_cli_sidecar(
    rootfs_paths: &RootfsPaths,
    okou_cli: Option<&OkouCliArtifact>,
) -> RunnerResult<()> {
    let sidecar = rootfs_paths.okou_cli_manifest();
    match okou_cli {
        Some(okou_cli) => tokio::fs::write(&sidecar, okou_cli.installed_manifest_bytes())
            .await
            .map_err(|e| {
                RunnerError::Internal(format!("write Okou CLI sidecar {}: {e}", sidecar.display()))
            }),
        None => match tokio::fs::remove_file(&sidecar).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(RunnerError::Internal(format!(
                "remove stale Okou CLI sidecar {}: {e}",
                sidecar.display()
            ))),
        },
    }
}

/// Check whether rootfs.ext4 exists.
///
/// Under the staging-rename contract, `rootfs.ext4` only exists if the
/// full assembly pipeline (download/build + customization) has committed,
/// so `true` here implies "fully built and ready to use". A concurrent
/// in-progress build writes to `rootfs.ext4.staging`, which this function
/// intentionally ignores.
async fn is_rootfs_present(rootfs: &RootfsPaths) -> RunnerResult<bool> {
    tokio::fs::try_exists(rootfs.rootfs())
        .await
        .map_err(|e| RunnerError::Internal(format!("check {}: {e}", rootfs.rootfs().display())))
}

#[cfg(test)]
mod tests;
