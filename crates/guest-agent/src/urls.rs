//! Derived webhook URLs built from the active API base URL.

use api_contracts::generated::routes;

pub(crate) fn events_url(base_url: &str) -> String {
    routes::webhooks::agent::events::SEND.url(base_url)
}

pub(crate) fn session_output_url(base_url: &str) -> String {
    routes::webhooks::agent::session_output::SEND.url(base_url)
}

pub(crate) fn complete_url(base_url: &str) -> String {
    routes::webhooks::agent::complete::COMPLETE.url(base_url)
}

pub(crate) fn heartbeat_url(base_url: &str) -> String {
    routes::webhooks::agent::heartbeat::SEND.url(base_url)
}

pub(crate) fn telemetry_url(base_url: &str) -> String {
    routes::webhooks::agent::telemetry::SEND.url(base_url)
}

pub(crate) fn checkpoint_prepare_history_url(base_url: &str) -> String {
    routes::webhooks::agent::checkpoints::prepare_history::PREPARE.url(base_url)
}

pub(crate) fn storage_prepare_url(base_url: &str) -> String {
    routes::webhooks::agent::storages::prepare::PREPARE.url(base_url)
}

pub(crate) fn storage_commit_url(base_url: &str) -> String {
    routes::webhooks::agent::storages::commit::COMMIT.url(base_url)
}

pub(crate) fn steered_input_url(base_url: &str, run_id: &str, event_id: &str) -> String {
    routes::runners::runs::by_run_id::steerable_inputs::by_event_id::steered::route(
        routes::runners::runs::by_run_id::steerable_inputs::by_event_id::steered::Params {
            run_id,
            event_id,
        },
    )
    .url(base_url)
}
