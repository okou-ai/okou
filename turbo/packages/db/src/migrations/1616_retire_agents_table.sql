DROP FUNCTION public.update_agent_metadata(text, uuid, text, boolean, boolean, text, integer, bytea, timestamp without time zone);
--> statement-breakpoint
DROP TABLE public.agents RESTRICT;
--> statement-breakpoint
DROP FUNCTION public.reject_retired_agent_write();
