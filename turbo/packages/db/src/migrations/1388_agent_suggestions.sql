CREATE TABLE "agent_suggestions" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "agent_suggestions_org_id_user_id_pk" PRIMARY KEY("org_id","user_id"),
	CONSTRAINT "agent_suggestions_entries_bound" CHECK (jsonb_typeof("agent_suggestions"."entries") = 'array' AND jsonb_array_length(jsonb_path_query_array("agent_suggestions"."entries", '$[*] ? (@.status == "active")')) <= 10)
);
