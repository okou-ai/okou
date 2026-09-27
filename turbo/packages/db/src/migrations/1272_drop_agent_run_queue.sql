-- Release 3 of the queued-run retirement. #37063 removed every read and write
-- of agent_run_queue, and production no longer runs an API without it. No table
-- references agent_run_queue; dropping it only removes its own foreign keys.
DROP TABLE "agent_run_queue";
