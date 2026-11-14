use api_contracts::{Method, ResolvedRoute, RouteTemplate, generated::routes};

#[test]
fn exposes_generated_webhook_route_constants() {
    let route = routes::webhooks::agent::events::SEND;

    assert_eq!(route.method, Method::Post);
    assert_eq!(route.method.as_str(), "POST");
    assert_eq!(route.path, "/api/webhooks/agent/events");
}

#[test]
fn exposes_generated_runner_route_constants() {
    let cancellation: RouteTemplate = routes::runners::runs::by_run_id::cancellation::GET;
    let heartbeat = routes::runners::heartbeat::HEARTBEAT;
    let realtime_token = routes::runners::realtime::token::CREATE;

    assert_eq!(cancellation.method, Method::Get);
    assert_eq!(cancellation.path, "/api/runners/runs/:runId/cancellation");
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
    let params = routes::runners::runs::by_run_id::cancellation::Params {
        run_id: "550e8400-e29b-41d4-a716-446655440000",
    };

    assert_eq!(
        routes::runners::runs::by_run_id::cancellation::path(params),
        "/api/runners/runs/550e8400-e29b-41d4-a716-446655440000/cancellation"
    );
    assert_eq!(
        routes::runners::runs::by_run_id::cancellation::path(
            routes::runners::runs::by_run_id::cancellation::Params {
                run_id: "space value",
            }
        ),
        "/api/runners/runs/space%20value/cancellation"
    );
    assert_eq!(
        routes::runners::runs::by_run_id::cancellation::path(
            routes::runners::runs::by_run_id::cancellation::Params {
                run_id: "nested/value",
            }
        ),
        "/api/runners/runs/nested%2Fvalue/cancellation"
    );
    assert_eq!(
        routes::runners::runs::by_run_id::cancellation::path(
            routes::runners::runs::by_run_id::cancellation::Params {
                run_id: "query?fragment#percent%中文",
            }
        ),
        "/api/runners/runs/query%3Ffragment%23percent%25%E4%B8%AD%E6%96%87/cancellation"
    );
}

#[test]
fn generated_routes_build_resolved_routes_with_params() {
    let resolved = routes::runners::runs::by_run_id::cancellation::route(
        routes::runners::runs::by_run_id::cancellation::Params {
            run_id: "550e8400-e29b-41d4-a716-446655440000",
        },
    );

    assert_eq!(resolved.method, Method::Get);
    assert_eq!(
        resolved.url("https://api.vm0.dev/"),
        "https://api.vm0.dev/api/runners/runs/550e8400-e29b-41d4-a716-446655440000/cancellation"
    );
    assert_eq!(
        resolved.url(""),
        "/api/runners/runs/550e8400-e29b-41d4-a716-446655440000/cancellation",
        "empty base URL must preserve the path-only behavior"
    );
}

#[test]
#[should_panic(expected = "api route path must start with '/'")]
fn route_urls_reject_paths_without_leading_slash() {
    let route = api_contracts::Route::new(Method::Post, "api/runners/heartbeat");

    let _ = route.url("https://api.vm0.dev");
}

#[test]
#[should_panic(expected = "api route path must start with '/'")]
fn resolved_route_urls_reject_paths_without_leading_slash() {
    let route = ResolvedRoute::new(Method::Post, "api/runners/heartbeat".to_owned());

    let _ = route.url("https://api.vm0.dev");
}
