//! Fast-tier coverage for non-ChatGPT Codex app-server runs.

mod codex_app_server_startup;
mod codex_app_server_startup_policy;
use guest_agent_tests as common;

use std::collections::HashMap;

#[tokio::test]
async fn codex_app_server_enables_fast_mode_without_chatgpt_account()
-> Result<(), Box<dyn std::error::Error>> {
    codex_app_server_startup::assert_codex_app_server_startup_case(
        codex_app_server_startup::CodexAppServerStartupCase {
            run_id: "codex-app-server-fast-mode-without-chatgpt-test",
            user_env: HashMap::from([
                ("OPENAI_API_KEY".to_string(), "sk-test".to_string()),
                ("OPENAI_MODEL".to_string(), "gpt-5.6-luna".to_string()),
                ("OKOU_CODEX_SERVICE_TIER".to_string(), "fast".to_string()),
            ]),
            expect_fast_mode: true,
        },
    )
    .await
}
