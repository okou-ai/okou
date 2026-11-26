ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_launch_snapshot_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_launch_snapshot_check" CHECK ((
          "agent_runs"."launch_snapshot" IS NULL OR (
            jsonb_typeof("agent_runs"."launch_snapshot") = 'object' AND
            jsonb_typeof("agent_runs"."launch_snapshot" -> 'framework') = 'string' AND
            "agent_runs"."launch_snapshot" ->> 'framework' = ANY (
              ARRAY['claude-code', 'codex', 'pi', 'antigravity']
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
                "agent_runs"."launch_snapshot" -> 'schemaVersion' IN ('3'::jsonb, '5'::jsonb)
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
