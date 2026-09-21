-- #35561: durable Pi inference is removed. The feature never carried real
-- traffic: `piDeferredSandbox` shipped `enabled: false` with no org hashes and
-- production telemetry recorded activity on two days only, all internal
-- testing.
--
-- Every writer of these five tables was deleted by #35559, which shipped in
-- `api-v1.642.2`. This drop is deliberately a separate release: migrations run
-- before API promotion, so dropping the tables in the same release as the code
-- removal would have run this statement while the previous backend was still
-- serving traffic, and `checkRunConcurrencyLimit` read these tables on every
-- run creation with no schema-version or feature-switch gate. See
-- `docs/deployment-compatibility.md`. The pre-removal backend has drained, so
-- nothing that can insert here is still running.
--
-- No backfill: nothing is preserved. The remaining rows are terminal internal
-- test records with no downstream consumer, and the erasure path that used to
-- read `agent_run_inference_objects` was detached by #35559. The omission is a
-- decision, not an oversight.
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
