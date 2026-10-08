mod final_identity;
mod materialization;
mod reuse_identity;

use sha2::{Digest, Sha256};

use crate::restored_session_identity::RestoredSessionHistoryPrefixAttribution;
use crate::test_fixtures::session_history::OneShotSessionHistoryServer;

const LARGE_SESSION_HISTORY_SIZE_BYTES: usize = 1024 * 1024 + 1;

fn history_prefix_attribution(history: &[u8]) -> RestoredSessionHistoryPrefixAttribution {
    RestoredSessionHistoryPrefixAttribution::for_test(
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
    )
}

async fn serve_history_once(body: &[u8]) -> OneShotSessionHistoryServer {
    OneShotSessionHistoryServer::respond_once("200 OK", body.to_vec(), Some(body.len() as u64))
        .await
}

fn assert_successful_action(ops: &[(String, bool, Option<String>)], action: &str) {
    assert!(
        ops.iter().any(|op| op.0 == action && op.1),
        "expected {action} telemetry, got: {ops:?}"
    );
}
