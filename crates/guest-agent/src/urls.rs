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

pub(crate) fn active_input_receipt_url(base_url: &str, run_id: &str, delivery_id: &str) -> String {
    routes::runners::runs::by_run_id::active_inputs::deliveries::by_delivery_id::receipt::route(
        routes::runners::runs::by_run_id::active_inputs::deliveries::by_delivery_id::receipt::Params {
            run_id,
            delivery_id,
        },
    )
    .url(base_url)
}

pub(crate) fn deferred_pi_handoff_url(base_url: &str, run_id: &str, offset: u64) -> String {
    let offset = offset.to_string();
    routes::runners::jobs::by_id::pi_handoff::by_offset::route(
        routes::runners::jobs::by_id::pi_handoff::by_offset::Params {
            id: run_id,
            offset: &offset,
        },
    )
    .url(base_url)
}
