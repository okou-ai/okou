use super::SandboxFinalExecParkHandoff;

#[test]
fn final_exec_park_handoff_accepts_only_one_request() {
    let handoff = SandboxFinalExecParkHandoff::new();

    assert!(handoff.request());
    assert!(!handoff.request());
    assert!(handoff.accept_if_requested());
    assert!(!handoff.cancel());
}

#[test]
fn final_exec_park_handoff_cancellation_closes_unaccepted_request() {
    let handoff = SandboxFinalExecParkHandoff::new();

    assert!(handoff.request());
    assert!(handoff.cancel());
    assert!(!handoff.accept_if_requested());
    assert!(!handoff.request());
}

#[test]
fn final_exec_park_handoff_cancellation_closes_before_request() {
    let handoff = SandboxFinalExecParkHandoff::new();

    assert!(handoff.cancel());
    assert!(!handoff.request());
    assert!(!handoff.accept_if_requested());
}
