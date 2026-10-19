//! Fast mode startup coverage for ChatGPT-authenticated Codex app-server runs.

mod codex_app_server_startup;
mod codex_app_server_startup_policy;
use guest_agent_tests as common;

use std::collections::HashMap;

#[tokio::test]
async fn codex_app_server_enables_fast_mode_for_eligible_chatgpt_run()
-> Result<(), Box<dyn std::error::Error>> {
    codex_app_server_startup::assert_codex_app_server_startup_case(
        codex_app_server_startup::CodexAppServerStartupCase {
            run_id: "codex-app-server-fast-mode-test",
            user_env: HashMap::from([
                ("CHATGPT_ACCOUNT_ID".to_string(), "account-test".to_string()),
                ("OPENAI_MODEL".to_string(), "gpt-5.5".to_string()),
                ("OKOU_CODEX_SERVICE_TIER".to_string(), "fast".to_string()),
            ]),
            expect_fast_mode: true,
        },
    )
    .await
}
