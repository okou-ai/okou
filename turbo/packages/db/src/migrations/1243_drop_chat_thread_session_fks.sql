-- chat_threads session binding columns no longer reference agent_sessions or
-- agent_runs. Binding writes stop taking KEY SHARE on those rows, and deleting
-- a run or session no longer scans the unindexed columns for SET NULL. A
-- dangling id resolves as an uninitialized binding.
ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_agent_session_id_agent_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_agent_session_run_id_agent_runs_id_fk";
