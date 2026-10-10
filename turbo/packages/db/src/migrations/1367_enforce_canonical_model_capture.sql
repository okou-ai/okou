ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_canonical_selection_check" CHECK ("agent_runs"."selected_model" IS NULL OR (
          "agent_runs"."selected_model" NOT IN ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max') AND
          "agent_runs"."selected_model" NOT LIKE '@preset/%'
        )) NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_runtime_pair_check" CHECK (("agent_runs"."model_runtime_provider" IS NULL AND "agent_runs"."model_runtime_model" IS NULL) OR (
          "agent_runs"."model_runtime_provider" IS NOT NULL AND char_length("agent_runs"."model_runtime_provider") > 0 AND
          "agent_runs"."model_runtime_model" IS NOT NULL AND char_length("agent_runs"."model_runtime_model") > 0
        )) NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_personal_capture_check" CHECK ("agent_runs"."model_provider" NOT IN ('codex-oauth-token', 'claude-code-oauth-token') OR COALESCE((
          "agent_runs"."built_in_model_key_id" IS NULL AND "agent_runs"."model_usage_provider" IS NULL AND
          "agent_runs"."model_long_context_min_total_input_tokens" IS NULL AND
          (NOT ("agent_runs"."launch_snapshot" IS NOT NULL AND "agent_runs"."status" IN ('pending', 'running')) OR
            "agent_runs"."selected_model" IS NOT NULL) AND
          (
            ("agent_runs"."model_runtime_model" IS NULL AND NOT (
              "agent_runs"."launch_snapshot" IS NOT NULL AND "agent_runs"."status" IN ('pending', 'running')
            )) OR (
              "agent_runs"."model_runtime_model" IS NOT NULL AND
              ("agent_runs"."model_runtime_provider" = "agent_runs"."model_provider" OR (
                "agent_runs"."model_provider" = 'codex-oauth-token' AND
                "agent_runs"."model_runtime_provider" = 'openai-codex'
              )) AND
              ("agent_runs"."selected_model" IS NULL OR "agent_runs"."selected_model" <> 'auto') AND
              "agent_runs"."model_provider_id" IS NOT NULL AND (
                "agent_runs"."model_provider_account_identity" IS NULL OR
                char_length("agent_runs"."model_provider_account_identity") > 0
              )
            )
          )
        ), false)) NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_builtin_capture_owner_check" CHECK ("agent_runs"."model_provider" <> 'built-in' OR COALESCE((
          ("agent_runs"."model_provider_id" IS NULL OR (
            "agent_runs"."status" IN ('completed', 'failed', 'cancelled', 'timeout') AND
            "agent_runs"."model_runtime_provider" IS NULL AND "agent_runs"."model_runtime_model" IS NULL AND
            "agent_runs"."built_in_model_key_id" IS NULL AND "agent_runs"."model_usage_provider" IS NULL AND
            "agent_runs"."model_long_context_min_total_input_tokens" IS NULL
          )) AND "agent_runs"."model_provider_account_identity" IS NULL AND
          ("agent_runs"."model_runtime_model" IS NULL OR (
            "agent_runs"."built_in_model_key_id" IS NOT NULL AND
            "agent_runs"."model_runtime_provider" NOT IN ('codex-oauth-token', 'claude-code-oauth-token')
          )) AND (NOT (
            "agent_runs"."launch_snapshot" IS NOT NULL AND "agent_runs"."status" IN ('pending', 'running') AND
            "agent_runs"."selected_model" IS NOT DISTINCT FROM 'auto'
          ) OR "agent_runs"."model_usage_provider" IS NOT NULL)
        ), false)) NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_usage_capture_check" CHECK (("agent_runs"."model_long_context_min_total_input_tokens" IS NULL OR (
          "agent_runs"."model_usage_provider" IS NOT NULL AND "agent_runs"."model_long_context_min_total_input_tokens" > 0
        )) AND ("agent_runs"."model_usage_provider" IS NULL OR COALESCE((
          char_length("agent_runs"."model_usage_provider") > 0 AND "agent_runs"."model_provider" = 'built-in' AND
          "agent_runs"."model_runtime_provider" IS NOT NULL AND "agent_runs"."model_runtime_model" IS NOT NULL AND
          "agent_runs"."built_in_model_key_id" IS NOT NULL
        ), false))) NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_canonical_selection_check" CHECK ("chat_events"."model_selection" IS NULL OR (
          "chat_events"."model_selection" ->> 'selectedModel' NOT IN ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max') AND
          "chat_events"."model_selection" ->> 'selectedModel' NOT LIKE '@preset/%'
        )) NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_canonical_annotation_check" CHECK (NOT jsonb_path_exists("chat_events"."payload", '$.userMessage.parts[*] ? (@.type == "model" && (@.selectedModel == "okou-1.0" || @.selectedModel == "okou-1.0-pro" || @.selectedModel == "okou-1.0-max" || @.selectedModel starts with "@preset/"))')) NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_thread_events" ADD CONSTRAINT "chat_thread_events_canonical_selection_check" CHECK (("chat_thread_events"."selected_model" IS NULL OR (
          "chat_thread_events"."selected_model" NOT IN ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max') AND "chat_thread_events"."selected_model" NOT LIKE '@preset/%'
        )) AND ("chat_thread_events"."kind" NOT IN ('created', 'model_selection_updated') OR "chat_thread_events"."selected_model" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_canonical_selection_check" CHECK ("chat_threads"."selected_model" NOT IN ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max') AND "chat_threads"."selected_model" NOT LIKE '@preset/%') NOT VALID;--> statement-breakpoint
ALTER TABLE "org_members_metadata" ADD CONSTRAINT "org_members_metadata_canonical_selection_check" CHECK ("org_members_metadata"."selected_model" NOT IN ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max') AND "org_members_metadata"."selected_model" NOT LIKE '@preset/%') NOT VALID;