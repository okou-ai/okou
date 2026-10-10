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
        held_home_states: vec![],
        active_reuse_producers: Vec::<ActiveReuseProducer>::new(),
        wss_ingress_service_active: false,
        mode: "running".into(),
    }
}

#[test]
fn heartbeat_serializes_empty_home_inventory() {
    let body = serde_json::to_value(heartbeat()).unwrap();
    assert_eq!(body["heldHomeStates"], json!([]));
}

#[test]
fn home_inventory_keeps_the_per_cache_format_discriminator() {
    let mut state = heartbeat();
    let body = serde_json::to_value(&state).unwrap();
    assert_eq!(body["heldHomeStates"], json!([]));
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
}
