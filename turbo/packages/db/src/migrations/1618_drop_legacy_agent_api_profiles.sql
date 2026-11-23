-- PL/pgSQL bodies are not tracked dependencies, so drop the function explicitly.
-- RESTRICT rejects the table drop while any tracked object still depends on it.
DROP FUNCTION public.update_legacy_agent_api_metadata(text, uuid, text, boolean, boolean, text, integer, bytea, timestamp without time zone);
--> statement-breakpoint
DROP TABLE public.legacy_agent_api_profiles RESTRICT;
