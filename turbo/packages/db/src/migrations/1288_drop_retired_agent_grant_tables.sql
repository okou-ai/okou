-- The last production grant reader was removed in a prior release (#37305).
-- Drop only the retired tables; fail instead of cascading to unexpected dependents.
DROP TABLE "agent_ssh_access";--> statement-breakpoint
DROP TABLE "agent_vnc_access";
