use runner_types::types::{
    ActiveReuseProducer, HOME_AFFINITY_VERSION, HeartbeatState, HeldHomeState, HomeCacheCapability,
};
use serde_json::json;

fn heartbeat() -> HeartbeatState {
    HeartbeatState {
        runner_id: "550e8400-e29b-41d4-a716-446655440000".into(),
        group: "vm0/test".into(),
        snapshot_generation: 7,
        snapshot_sequence: 42,
        total_vcpu: 8,
        total_memory_mb: 16384,
        max_concurrent: 2,
        allocated_vcpu: 0,
        allocated_memory_mb: 0,
        running_count: 0,
        admittable_profiles: vec!["vm0/default".into()],
        held_sandbox_states: vec![],
        held_workspace_states: vec![],
        home_affinity_version: None,
        held_home_states: vec![],
        active_reuse_producers: Vec::<ActiveReuseProducer>::new(),
        wss_ingress_service_active: false,
        mode: "running".into(),
    }
}

#[test]
fn preparation_does_not_advertise_home_support_from_outgoing_heartbeat() {
    let body = serde_json::to_value(heartbeat()).unwrap();
    assert!(body.get("homeAffinityVersion").is_none());
    assert!(body.get("heldHomeStates").is_none());
    assert_eq!(body["heldWorkspaceStates"], json!([]));
}

#[test]
fn capable_empty_heartbeat_keeps_capability_independent_of_held_images() {
    let mut state = heartbeat();
    state.home_affinity_version = Some(HOME_AFFINITY_VERSION);
    let body = serde_json::to_value(&state).unwrap();
    assert_eq!(body["homeAffinityVersion"], 1);
    assert!(body.get("heldHomeStates").is_none());
    state.held_home_states.push(HeldHomeState {
        reuse_key: "thread:thread-a".into(),
        last_completed_at: "2026-10-09T00:00:00.000Z".into(),
        home_caches: vec![HomeCacheCapability {
            profile: "vm0/default".into(),
            home_affinity_version: HOME_AFFINITY_VERSION,
        }],
    });
    let body = serde_json::to_value(state).unwrap();
    assert_eq!(
        body["heldHomeStates"],
        json!([{
            "reuseKey": "thread:thread-a",
            "lastCompletedAt": "2026-10-09T00:00:00.000Z",
            "homeCaches": [{"profile": "vm0/default", "homeAffinityVersion": 1}]
        }])
    );
    assert_eq!(body["heldWorkspaceStates"], json!([]));
}
