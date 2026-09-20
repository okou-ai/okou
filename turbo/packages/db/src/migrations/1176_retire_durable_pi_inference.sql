-- #35559: durable Pi inference is removed. The feature never carried real
-- traffic: `piDeferredSandbox` shipped `enabled: false` with no org hashes and
-- production telemetry recorded activity on two days only, all internal
-- testing. Every writer of these five tables is deleted in the same pull
-- request, and migrations run before API promotion, so nothing can insert here
-- once this statement commits.
--
-- Measured before the drop: agent_run_inference 24 rows, agent_run_sandbox_intent
-- 16, agent_run_sandbox_lease 16, agent_run_inference_objects 91,
-- pi_inference_objects 90 — all explained by the 24 internal durable runs.
--
-- No backfill: nothing is preserved. The remaining rows are terminal internal
-- test records with no downstream consumer, and the erasure path that used to
-- read `agent_run_inference_objects` was detached earlier in this change. The
-- omission is a decision, not an oversight.
SELECT pg_advisory_xact_lock(hashtext('durable_pi_inference_retirement'));
--> statement-breakpoint
-- Child-to-parent order, matching the cascade an ordinary run deletion takes.
-- Plain DROP keeps each statement restricted to its own table, so any external
-- dependency this issue did not account for aborts the whole migration instead
-- of being silently cascaded away.
DROP TABLE public.agent_run_inference_objects;
--> statement-breakpoint
DROP TABLE public.pi_inference_objects;
--> statement-breakpoint
DROP TABLE public.agent_run_sandbox_lease;
--> statement-breakpoint
DROP TABLE public.agent_run_sandbox_intent;
--> statement-breakpoint
DROP TABLE public.agent_run_inference;
