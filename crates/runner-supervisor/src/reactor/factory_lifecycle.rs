//! Sandbox factory creation and shutdown for `runner start`.

use std::collections::BTreeMap;
#[cfg(test)]
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use sandbox::{SandboxFactory, SandboxRuntime};
use tracing::{error, info};

use super::RuntimeProfile as ProfileConfig;
use super::TeardownTimer;
use super::error::{ReactorError as RunnerError, ReactorResult as RunnerResult};
#[cfg(test)]
use runner_host::paths::HomePaths;

/// A sandbox factory shared across concurrent job executors.
///
/// The runner retains one owner while live jobs and idle sandboxes clone the
/// `Arc`. Shutdown begins only after the runner recovers exclusive mutable
/// access to every factory.
use crate::SharedFactory;

/// Build one sandbox factory per configured profile.
///
/// On failure, already-created factories are stopped, but shared runtime
/// resources remain owned by the caller so dependent services can stop before
/// the runtime removes their network isolation.
pub(super) async fn start_factories(
    profiles: &BTreeMap<String, ProfileConfig>,
    runtime: &mut dyn SandboxRuntime,
    home_cache: Option<&crate::home_image_cache::HomeImageCache>,
) -> RunnerResult<BTreeMap<String, (SharedFactory, bool)>> {
    let mut factories: BTreeMap<String, (Box<dyn SandboxFactory>, bool)> = BTreeMap::new();
    for (profile_name, profile_config) in profiles {
        let mut factory_config = profile_config.factory_config.clone();
        factory_config.home_drive_pressure =
            home_cache.map(|cache| cache.home_drive_pressure_policy());
        let restore_guest_state = factory_config.snapshot.is_some();
        let factory_result = runtime.create_factory(factory_config).await;
        let factory = match factory_result {
            Ok(factory) => factory,
            Err(e) => {
                for (name, (mut factory, _)) in factories {
                    shutdown_factory_instance(&name, factory.as_mut(), None).await;
                }
                return Err(e.into());
            }
        };
        factories.insert(profile_name.clone(), (factory, restore_guest_state));
        info!(profile = %profile_name, "factory started");
    }
    Ok(factories
        .into_iter()
        .map(|(name, (factory, restore_guest_state))| {
            (name, (Arc::new(factory), restore_guest_state))
        })
        .collect())
}

async fn shutdown_factory_instance(
    name: &str,
    factory: &mut dyn SandboxFactory,
    teardown: Option<&TeardownTimer>,
) {
    let phase = teardown.map(|timer| {
        let phase_start = Instant::now();
        info!(
            phase = "factory_shutdown",
            profile = %name,
            elapsed_ms = timer.elapsed_ms(),
            "teardown phase started"
        );
        phase_start
    });
    factory.shutdown().await;
    if let (Some(timer), Some(phase)) = (teardown, phase) {
        info!(
            phase = "factory_shutdown",
            profile = %name,
            phase_ms = TeardownTimer::duration_ms(phase.elapsed()),
            elapsed_ms = timer.elapsed_ms(),
            "teardown phase complete"
        );
    }
}

/// Shut down all factories while retaining shared runtime resources.
///
/// Every factory must be exclusively mutable before any shutdown begins. On
/// failure, the complete map remains intact and no factory has been stopped.
pub(super) async fn shutdown_factory_instances(
    factories: &mut BTreeMap<String, (SharedFactory, bool)>,
    teardown: Option<&TeardownTimer>,
) -> RunnerResult<()> {
    let mut exclusive_factories = Vec::with_capacity(factories.len());
    let mut retained_profiles = Vec::new();
    for (name, (factory, _)) in factories.iter_mut() {
        let strong_count = Arc::strong_count(factory);
        let weak_count = Arc::weak_count(factory);
        match Arc::get_mut(factory) {
            Some(factory) => exclusive_factories.push((name.as_str(), factory.as_mut())),
            None => {
                retained_profiles.push(format!("{name} (strong={strong_count}, weak={weak_count})"))
            }
        }
    }

    if !retained_profiles.is_empty() {
        let retained_profiles = retained_profiles.join(", ");
        error!(
            retained_profiles = %retained_profiles,
            "factory shutdown requires exclusive ownership"
        );
        return Err(RunnerError::Internal(format!(
            "factory shutdown requires exclusive ownership: {retained_profiles}"
        )));
    }

    for (name, factory) in exclusive_factories {
        shutdown_factory_instance(name, factory, teardown).await;
    }
    factories.clear();
    Ok(())
}

/// Release runtime-owned shared resources after their dependent services stop.
pub(super) async fn shutdown_runtime(
    runtime: &mut dyn SandboxRuntime,
    teardown: Option<&TeardownTimer>,
) {
    // Clean up runtime-owned shared resources (netns and NBD device pools).
    let phase = teardown.map(|timer| timer.phase_start("runtime_shutdown"));
    runtime.shutdown().await;
    if let (Some(timer), Some(phase)) = (teardown, phase) {
        timer.phase_complete("runtime_shutdown", phase);
    }
}

#[cfg(test)]
mod tests;
