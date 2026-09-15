CREATE TABLE "agent_run_inference" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"source_conversation_id" uuid,
	"input" jsonb NOT NULL,
	"phase" text NOT NULL,
	"owner_epoch" integer NOT NULL,
	"deadline_at" timestamp NOT NULL,
	"activation_ready" boolean DEFAULT false NOT NULL,
	"provider_attempt_id" uuid NOT NULL,
	"provider_attempt_state" text NOT NULL,
	"publication" jsonb,
	"published_sequence" integer,
	"usage_settled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "agent_run_inference_epoch_check" CHECK ("agent_run_inference"."owner_epoch" >= 1),
	CONSTRAINT "agent_run_inference_phase_check" CHECK ("agent_run_inference"."phase" IN ('admitted', 'ready', 'provider', 'publishing', 'sandbox_waiting', 'sandbox_preparing', 'sandbox_ready', 'sandbox_running', 'terminal')),
	CONSTRAINT "agent_run_inference_attempt_check" CHECK ("agent_run_inference"."provider_attempt_state" IN ('not-started', 'may-have-started', 'settled') AND ("agent_run_inference"."phase" <> 'provider' OR ("agent_run_inference"."activation_ready" AND "agent_run_inference"."provider_attempt_state" = 'may-have-started')) AND ("agent_run_inference"."provider_attempt_state" <> 'settled' OR "agent_run_inference"."publication" IS NOT NULL) AND ("agent_run_inference"."phase" <> 'publishing' OR "agent_run_inference"."provider_attempt_state" = 'settled')),
	CONSTRAINT "agent_run_inference_input_check" CHECK (jsonb_typeof("agent_run_inference"."input") = 'object' AND "agent_run_inference"."input" ?& ARRAY['schemaVersion', 'inputEventId', 'inputGeneration', 'configurationHash', 'contextHash', 'h0', 'deferredSecrets'] AND "agent_run_inference"."input"->'schemaVersion' = '1'::jsonb),
	CONSTRAINT "agent_run_inference_sequence_check" CHECK ("agent_run_inference"."published_sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_run_sandbox_intent" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"generation" integer NOT NULL,
	"continuation" jsonb NOT NULL,
	"state" text NOT NULL,
	"enqueued_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"owner_epoch" integer NOT NULL,
	"attempt_deadline_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"notified_at" timestamp,
	CONSTRAINT "agent_run_sandbox_intent_epoch_check" CHECK ("agent_run_sandbox_intent"."generation" >= 1 AND "agent_run_sandbox_intent"."owner_epoch" >= 1 AND "agent_run_sandbox_intent"."attempts" >= 0),
	CONSTRAINT "agent_run_sandbox_intent_state_check" CHECK ("agent_run_sandbox_intent"."state" IN ('waiting', 'preparing', 'ready', 'claimed', 'cancelled', 'expired', 'settled')),
	CONSTRAINT "agent_run_sandbox_intent_expiry_check" CHECK ("agent_run_sandbox_intent"."expires_at" > "agent_run_sandbox_intent"."enqueued_at" AND "agent_run_sandbox_intent"."expires_at" <= "agent_run_sandbox_intent"."enqueued_at" + interval '2 hours')
);
--> statement-breakpoint
CREATE TABLE "agent_run_sandbox_lease" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"owner_epoch" integer NOT NULL,
	"deadline_at" timestamp NOT NULL,
	"runner_id" uuid,
	"release_evidence" text,
	CONSTRAINT "agent_run_sandbox_lease_epoch_check" CHECK ("agent_run_sandbox_lease"."owner_epoch" >= 1),
	CONSTRAINT "agent_run_sandbox_lease_state_check" CHECK ("agent_run_sandbox_lease"."state" IN ('reserved', 'preparing', 'ready', 'claimed', 'releasing', 'released') AND ("agent_run_sandbox_lease"."state" <> 'claimed' OR "agent_run_sandbox_lease"."runner_id" IS NOT NULL)),
	CONSTRAINT "agent_run_sandbox_lease_release_check" CHECK (("agent_run_sandbox_lease"."state" = 'released' AND "agent_run_sandbox_lease"."release_evidence" IS NOT NULL AND length("agent_run_sandbox_lease"."release_evidence") > 0) OR ("agent_run_sandbox_lease"."state" <> 'released' AND "agent_run_sandbox_lease"."release_evidence" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_run_inference" ADD CONSTRAINT "agent_run_inference_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_inference" ADD CONSTRAINT "agent_run_inference_source_conversation_id_conversations_id_fk" FOREIGN KEY ("source_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_sandbox_intent" ADD CONSTRAINT "agent_run_sandbox_intent_run_id_agent_run_inference_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run_inference"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_sandbox_lease" ADD CONSTRAINT "agent_run_sandbox_lease_run_id_agent_run_sandbox_intent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run_sandbox_intent"("run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_inference_source_idx" ON "agent_run_inference" USING btree ("source_conversation_id");--> statement-breakpoint
CREATE INDEX "agent_run_inference_deadline_idx" ON "agent_run_inference" USING btree ("phase","deadline_at","run_id");--> statement-breakpoint
CREATE INDEX "agent_run_sandbox_intent_queue_idx" ON "agent_run_sandbox_intent" USING btree ("state","enqueued_at","run_id");--> statement-breakpoint
CREATE INDEX "agent_run_sandbox_intent_attempt_idx" ON "agent_run_sandbox_intent" USING btree ("state","attempt_deadline_at","run_id");--> statement-breakpoint
CREATE INDEX "agent_run_sandbox_intent_expiry_idx" ON "agent_run_sandbox_intent" USING btree ("state","expires_at","run_id");--> statement-breakpoint
CREATE INDEX "agent_run_sandbox_lease_deadline_idx" ON "agent_run_sandbox_lease" USING btree ("state","deadline_at","run_id");--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_launch_snapshot_check";
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_launch_snapshot_check" CHECK ((
          "agent_runs"."launch_snapshot" IS NULL OR (
            jsonb_typeof("agent_runs"."launch_snapshot") = 'object' AND
            jsonb_typeof("agent_runs"."launch_snapshot" -> 'framework') = 'string' AND
            "agent_runs"."launch_snapshot" ->> 'framework' = ANY (
              ARRAY['claude-code', 'codex', 'pi']
            ) AND
            ((
              jsonb_typeof(
              "agent_runs"."launch_snapshot" -> 'runnerProfile'
            ) = 'string' AND
            char_length("agent_runs"."launch_snapshot" ->> 'runnerProfile') >= 1 AND
            char_length("agent_runs"."launch_snapshot" ->> 'runnerProfile') <= 255 AND
            (
              (
                "agent_runs"."launch_snapshot" ?& ARRAY[
                  'schemaVersion',
                  'framework',
                  'runnerProfile'
                ] AND
                (
                  "agent_runs"."launch_snapshot" -
                  'schemaVersion' -
                  'framework' -
                  'runnerProfile'
                ) = '{}'::jsonb AND
                "agent_runs"."launch_snapshot" -> 'schemaVersion' = '1'::jsonb
              ) OR (
                "agent_runs"."launch_snapshot" ?& ARRAY[
                  'schemaVersion',
                  'framework',
                  'runnerProfile',
                  'piMemoryGenerationEnabled'
                ] AND
                (
                  "agent_runs"."launch_snapshot" -
                  'schemaVersion' -
                  'framework' -
                  'runnerProfile' -
                  'piMemoryGenerationEnabled'
                ) = '{}'::jsonb AND
                "agent_runs"."launch_snapshot" -> 'schemaVersion' = '2'::jsonb AND
                jsonb_typeof(
                  "agent_runs"."launch_snapshot" -> 'piMemoryGenerationEnabled'
                ) = 'boolean'
              ) OR (
                "agent_runs"."launch_snapshot" ?& ARRAY[
                  'schemaVersion',
                  'framework',
                  'runnerProfile'
                ] AND
                (
                  "agent_runs"."launch_snapshot" -
                  'schemaVersion' -
                  'framework' -
                  'runnerProfile'
                ) = '{}'::jsonb AND
                "agent_runs"."launch_snapshot" -> 'schemaVersion' = '3'::jsonb
              )
            )
            ) OR (
              "agent_runs"."launch_snapshot" ?& ARRAY['schemaVersion', 'framework', 'executionMode', 'inferenceContractVersion'] AND
              ("agent_runs"."launch_snapshot" - 'schemaVersion' - 'framework' - 'executionMode' - 'inferenceContractVersion') = '{}'::jsonb AND
              "agent_runs"."launch_snapshot"->'schemaVersion' = '4'::jsonb AND
              "agent_runs"."launch_snapshot"->>'framework' = 'pi' AND
              "agent_runs"."launch_snapshot"->'executionMode' = '"api-inference"'::jsonb AND
              "agent_runs"."launch_snapshot"->'inferenceContractVersion' = '1'::jsonb
            ))
          )
        )) NOT VALID;
