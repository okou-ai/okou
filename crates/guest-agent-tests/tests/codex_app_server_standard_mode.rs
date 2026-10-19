//! Standard-tier startup coverage for ChatGPT-authenticated Codex app-server runs.

mod codex_app_server_startup;
mod codex_app_server_startup_policy;
use guest_agent_tests as common;

use std::collections::HashMap;

#[tokio::test]
async fn codex_app_server_omits_fast_mode_for_standard_chatgpt_run()
-> Result<(), Box<dyn std::error::Error>> {
    codex_app_server_startup::assert_codex_app_server_startup_case(
        codex_app_server_startup::CodexAppServerStartupCase {
            run_id: "codex-app-server-standard-mode-test",
            user_env: HashMap::from([
                ("CHATGPT_ACCOUNT_ID".to_string(), "account-test".to_string()),
                ("OPENAI_MODEL".to_string(), "gpt-5.5".to_string()),
            ]),
            expect_fast_mode: false,
        },
    )
    .await
}
