use api_contracts::{Method, ResolvedRoute, RouteTemplate, generated::routes};

#[test]
fn exposes_generated_webhook_route_constants() {
    let route = routes::webhooks::agent::events::SEND;

    assert_eq!(route.method, Method::Post);
    assert_eq!(route.method.as_str(), "POST");
    assert_eq!(route.path, "/api/webhooks/agent/events");
}

#[test]
fn exposes_nested_generated_webhook_route_constants() {
    let checkpoint = routes::webhooks::agent::checkpoints::CREATE;
    let prepare_history = routes::webhooks::agent::checkpoints::prepare_history::PREPARE;

    assert_eq!(checkpoint.method, Method::Post);
    assert_eq!(checkpoint.path, "/api/webhooks/agent/checkpoints");
    assert_eq!(prepare_history.method, Method::Post);
    assert_eq!(
        prepare_history.path,
        "/api/webhooks/agent/checkpoints/prepare-history"
    );
}

#[test]
fn exposes_generated_runner_route_constants() {
    let poll = routes::runners::poll::POLL;
    let claim: RouteTemplate = routes::runners::jobs::by_id::claim::CLAIM;
    let heartbeat = routes::runners::heartbeat::HEARTBEAT;
    let realtime_token = routes::runners::realtime::token::CREATE;

    assert_eq!(poll.method, Method::Post);
    assert_eq!(poll.path, "/api/runners/poll");
    assert_eq!(claim.method, Method::Post);
    assert_eq!(claim.path, "/api/runners/jobs/:id/claim");
    assert_eq!(heartbeat.method, Method::Post);
    assert_eq!(heartbeat.path, "/api/runners/heartbeat");
    assert_eq!(realtime_token.method, Method::Post);
    assert_eq!(realtime_token.path, "/api/runners/realtime/token");
}

#[test]
fn generated_routes_build_urls_from_base_api_url() {
    let route = routes::webhooks::agent::telemetry::SEND;

    assert_eq!(
        route.url("https://api.vm0.dev"),
        "https://api.vm0.dev/api/webhooks/agent/telemetry"
    );
    assert_eq!(
        route.url("https://api.vm0.dev/"),
        "https://api.vm0.dev/api/webhooks/agent/telemetry"
    );
    assert_eq!(
        route.url(""),
        "/api/webhooks/agent/telemetry",
        "empty base URL must preserve the old relative-path behavior"
    );
}

#[test]
fn generated_routes_build_paths_with_params() {
    let params = routes::runners::jobs::by_id::claim::Params {
        id: "550e8400-e29b-41d4-a716-446655440000",
    };

    assert_eq!(
        routes::runners::jobs::by_id::claim::path(params),
        "/api/runners/jobs/550e8400-e29b-41d4-a716-446655440000/claim"
    );
    assert_eq!(
        routes::runners::jobs::by_id::claim::path(routes::runners::jobs::by_id::claim::Params {
            id: "space value",
        }),
        "/api/runners/jobs/space%20value/claim"
    );
    assert_eq!(
        routes::runners::jobs::by_id::claim::path(routes::runners::jobs::by_id::claim::Params {
            id: "nested/value",
        }),
        "/api/runners/jobs/nested%2Fvalue/claim"
    );
    assert_eq!(
        routes::runners::jobs::by_id::claim::path(routes::runners::jobs::by_id::claim::Params {
            id: "query?fragment#percent%中文",
        }),
        "/api/runners/jobs/query%3Ffragment%23percent%25%E4%B8%AD%E6%96%87/claim"
    );
}

#[test]
fn generated_routes_build_resolved_routes_with_params() {
    let resolved =
        routes::runners::jobs::by_id::claim::route(routes::runners::jobs::by_id::claim::Params {
            id: "550e8400-e29b-41d4-a716-446655440000",
        });

    assert_eq!(resolved.method, Method::Post);
    assert_eq!(
        resolved.url("https://api.vm0.dev/"),
        "https://api.vm0.dev/api/runners/jobs/550e8400-e29b-41d4-a716-446655440000/claim"
    );
    assert_eq!(
        resolved.url(""),
        "/api/runners/jobs/550e8400-e29b-41d4-a716-446655440000/claim",
        "empty base URL must preserve the path-only behavior"
    );
}

#[test]
#[should_panic(expected = "api route path must start with '/'")]
fn route_urls_reject_paths_without_leading_slash() {
    let route = api_contracts::Route::new(Method::Post, "api/runners/poll");

    let _ = route.url("https://api.vm0.dev");
}

#[test]
#[should_panic(expected = "api route path must start with '/'")]
fn resolved_route_urls_reject_paths_without_leading_slash() {
    let route = ResolvedRoute::new(Method::Post, "api/runners/poll".to_owned());

    let _ = route.url("https://api.vm0.dev");
}
