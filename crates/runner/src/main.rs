mod axiom_layer;
mod cmd;
mod config;
mod deps;
mod error;
#[cfg(test)]
mod native_privacy;
use runner_executor::executor;
mod group;
use runner_host::idle_prune_control;
use runner_lifecycle::idle_pool;
use runner_provider::http;
mod image_hash;
mod io_limits;
use runner_executor::pre_spawn_admission;
use runner_host::live_runner_instances;
use runner_lifecycle::lifecycle;
mod profile;
use runner_lifecycle::resource_budget;
mod run_resolution;
mod runtime_overrides;
use runner_lifecycle::status;
mod status_file;
#[cfg(test)]
use runner_executor::test_fixtures;
#[cfg(test)]
mod test_fixtures_http_body;
use runner_lifecycle::home_image_cache;
use runner_lifecycle::home_mount;

use runner_network::{
    ca, dns, kmsg_log, network_log_drain, network_log_manager, network_logs, proxy,
};
use runner_remote::{guest_rpc, run_usage, ssh, tailscale, vnc};
use runner_storage::{r2_cache, storage_cache};

#[cfg(test)]
use sandbox::helper_exec;

// Runner build.rs owns the embedded addon inventory and passes it to runner-network.
include!(concat!(env!("OUT_DIR"), "/addon_files.rs"));

#[cfg(test)]
mod addon_inventory_tests;

// Source-observation API shared by the current-assignment usage composer.
// (no-op Runner release marker refreshed for production delivery at 2026-10-30T11:35:01+08:00)
pub use proxy::{
    CoverageReason, MitmRunUsage, MitmUsageHandle, RunUsageObservation, RunUsageSnapshot,
    TokenTotals,
};

use std::path::Path;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use tracing_subscriber::Layer as _;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::fmt::writer::MakeWriterExt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

const RUNNER_FMT_MAX_LEVEL: LevelFilter = LevelFilter::INFO;

#[derive(Parser)]
#[command(name = "runner", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Download Firecracker, kernel, and verify host prerequisites
    Setup,
    /// Build rootfs and snapshot into a unified image
    Build(cmd::BuildArgs),
    /// Generate runner.yaml from a pre-built image hash
    Config(cmd::ConfigArgs),
    /// Run a single bash command in a sandbox for benchmarking
    Benchmark(cmd::BenchmarkArgs),
    /// Execute a command inside a running sandbox for debugging
    Exec(cmd::ExecArgs),
    /// Start the runner and poll for jobs (must run setup + build first)
    Start(Box<cmd::StartArgs>),
    /// Manage the runner as a systemd service
    Service(cmd::ServiceArgs),
    /// Kill a running sandbox
    Kill(cmd::KillArgs),
    /// Clean up unused runner resources, artifacts, logs, and caches
    Gc(cmd::GcArgs),
    /// Inspect and clean up home image cache entries
    HomeImageCache(cmd::HomeImageCacheArgs),
    /// Runtime health diagnostics for all runners on the host
    Doctor(cmd::DoctorArgs),
    /// Local file-queue provider commands
    Local(cmd::LocalArgs),
}

const RUNNER_RELEASE: &str = concat!("v", env!("CARGO_PKG_VERSION"));

/// Read the optional canonical hostname before tracing starts.
///
/// Normal config loading remains responsible for reporting read, parse, and
/// validation failures. This early read only supplies trusted common Axiom
/// dimensions when the same Runner config boundary already accepts the value.
fn runner_hostname_from_config(path: &Path) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Partial {
        hostname: Option<String>,
    }

    let content = std::fs::read_to_string(path).ok()?;
    let hostname = serde_yaml_ng::from_str::<Partial>(&content)
        .ok()?
        .hostname?;
    config::validate_runner_hostname(&hostname).ok()?;
    Some(hostname)
}

/// Keep the runner release visible in log filenames across upgrades.
fn runner_log_prefix(release: &str) -> String {
    format!("runner-{release}")
}

/// Initialize tracing with a tee writer (stderr + rolling log file) plus an
/// optional Axiom layer.
///
/// Returns the [`tracing_appender::non_blocking::WorkerGuard`] that must be
/// held alive until the process exits so buffered logs are flushed.
fn init_tracing_with_file(
    axiom_layer: Option<axiom_layer::AxiomLayer>,
) -> Result<tracing_appender::non_blocking::WorkerGuard, Box<dyn std::error::Error>> {
    let home = runner_host::paths::HomePaths::new()?;
    init_tracing_at(home.logs_dir(), axiom_layer)
}

fn init_tracing_at(
    log_dir: std::path::PathBuf,
    axiom_layer: Option<axiom_layer::AxiomLayer>,
) -> Result<tracing_appender::non_blocking::WorkerGuard, Box<dyn std::error::Error>> {
    runner_host::log_file::ensure_log_dir(&log_dir)
        .map_err(|e| format!("create {}: {e}", log_dir.display()))?;

    let prefix = runner_log_prefix(RUNNER_RELEASE);

    let file_appender = tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix(prefix)
        .filename_suffix("log")
        .max_log_files(7)
        .build(log_dir)?;

    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let writer = std::io::stderr.and(non_blocking);

    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_writer(writer)
        .with_ansi(false)
        .with_filter(RUNNER_FMT_MAX_LEVEL);
    let axiom_layer = axiom_layer.map(axiom_layer::with_ingest_filter);
    tracing_subscriber::registry()
        .with(tracing_subscriber::filter::filter_fn(|metadata| {
            ssh::safe_log_metadata(metadata) && tailscale::safe_log_metadata(metadata)
        }))
        .with(fmt_layer)
        .with(axiom_layer)
        .init();

    Ok(guard)
}

/// Initialize tracing with stderr output only (no rolling log file on disk),
/// plus an optional Axiom layer.
///
/// Explicitly writes to stderr so commands like `runner exec` — which pipe the
/// guest program's stdout through verbatim — don't have tracing lines
/// interleaved into captured output. The `fmt::layer()` default writer is
/// stdout, which is the wrong sink for a CLI tool.
fn init_tracing_stderr(axiom_layer: Option<axiom_layer::AxiomLayer>) {
    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr)
        .with_filter(RUNNER_FMT_MAX_LEVEL);
    let axiom_layer = axiom_layer.map(axiom_layer::with_ingest_filter);
    tracing_subscriber::registry()
        .with(tracing_subscriber::filter::filter_fn(|metadata| {
            ssh::safe_log_metadata(metadata) && tailscale::safe_log_metadata(metadata)
        }))
        .with(fmt_layer)
        .with(axiom_layer)
        .init();
}

fn install_native_panic_hook() {
    let prior_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if tailscale::in_domain() {
            // Stop the raw payload before stderr and Sentry's panic integration.
            eprintln!("native Tailscale resource domain failed");
            sentry::capture_message(
                "native Tailscale resource domain failed",
                sentry::Level::Error,
            );
        } else {
            prior_panic(info);
        }
    }));
}

#[tokio::main]
async fn main() -> ExitCode {
    // Initialize Sentry panic reporting before anything else.
    // Disabled (zero overhead) when SENTRY_DSN is not set.
    let _sentry_guard = sentry::init((
        std::env::var("SENTRY_DSN").unwrap_or_default(),
        sentry::ClientOptions::new()
            .release(env!("CARGO_PKG_VERSION"))
            .default_integrations(false)
            .add_integration(sentry::integrations::panic::PanicIntegration::default()),
    ));

    install_native_panic_hook();

    if !nix::unistd::getuid().is_root() {
        eprintln!("error: runner must be run as root");
        return ExitCode::FAILURE;
    }

    let cli = Cli::parse();

    let runner_hostname = match &cli.command {
        Command::Start(args) => runner_hostname_from_config(&args.config),
        _ => None,
    };

    // Axiom layer (dual-write with fmt). Returns None — zero overhead — when
    // AXIOM_TOKEN_TELEMETRY / AXIOM_DATASET_SUFFIX are unset.
    let (axiom_layer, axiom_guard) = match axiom_layer::init(runner_hostname) {
        Some((layer, guard)) => (Some(layer), Some(guard)),
        None => (None, None),
    };

    let was_enabled = axiom_layer.is_some();
    let (_guard, axiom_installed) = match &cli.command {
        Command::Start(_) => match init_tracing_with_file(axiom_layer) {
            Ok(guard) => (Some(guard), was_enabled),
            Err(e) => {
                // The failed `init_tracing_with_file` already consumed `axiom_layer`,
                // so the stderr fallback runs without Axiom — acceptable degraded
                // mode (home/log-dir setup is already broken at this point).
                init_tracing_stderr(None);
                tracing::warn!("file logging unavailable, using stderr only: {e}");
                (None, false)
            }
        },
        _ => {
            init_tracing_stderr(axiom_layer);
            (None, was_enabled)
        }
    };

    if axiom_installed {
        tracing::info!("axiom telemetry enabled");
    } else {
        tracing::info!("axiom telemetry disabled");
    }

    let result = match cli.command {
        Command::Setup => cmd::run_setup().await.map(|()| ExitCode::SUCCESS),
        Command::Build(args) => {
            // Retain the package bytes until rootfs installation consumes them.
            #[cfg(bundled_okou_cli)]
            let _ = std::hint::black_box(cmd::embedded_cli_package());
            cmd::run_build(args, &sandbox_firecracker::FirecrackerSnapshotProvider)
                .await
                .map(|()| ExitCode::SUCCESS)
        }
        Command::Config(args) => cmd::run_config(args).await.map(|()| ExitCode::SUCCESS),
        Command::Benchmark(args) => {
            cmd::run_benchmark(args, &sandbox_firecracker::FirecrackerRuntimeProvider).await
        }
        Command::Exec(args) => cmd::run_exec(args, &sandbox_firecracker::FirecrackerControl).await,
        Command::Kill(args) => cmd::run_kill(args, &sandbox_firecracker::FirecrackerControl).await,
        Command::Start(args) => {
            cmd::run_start(*args, &sandbox_firecracker::FirecrackerRuntimeProvider)
                .await
                .map(|()| ExitCode::SUCCESS)
        }
        Command::Service(args) => cmd::run_service(args).await.map(|()| ExitCode::SUCCESS),
        Command::Gc(args) => cmd::run_gc(args).await.map(|()| ExitCode::SUCCESS),
        Command::HomeImageCache(args) => cmd::run_home_image_cache(args)
            .await
            .map(|()| ExitCode::SUCCESS),
        Command::Doctor(args) => cmd::run_doctor(args).await,
        Command::Local(args) => cmd::run_local(args).await,
    };

    let exit = match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    };

    if let Some(g) = axiom_guard {
        g.shutdown().await;
    }

    exit
}

#[cfg(test)]
mod tests;
