CREATE TABLE "voice_transcriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"run_id" uuid,
	"request_hash" text NOT NULL,
	"transcript" text,
	"audio_tokens" integer,
	"text_tokens" integer,
	"cached_text_tokens" integer,
	"cached_audio_tokens" integer,
	"output_tokens" integer,
	"settled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- Vertex standard non-global (US) tariff, in credits per million tokens.
-- https://cloud.google.com/model-garden/pricing
INSERT INTO usage_pricing (kind, provider, category, unit_price, unit_size) VALUES
  ('model','google/gemini-3.1-flash-lite','tokens.input.text',275,1000000),
  ('model','google/gemini-3.1-flash-lite','tokens.input.audio',550,1000000),
  ('model','google/gemini-3.1-flash-lite','tokens.input.cached_text',55,2000000),
  ('model','google/gemini-3.1-flash-lite','tokens.input.cached_audio',55,1000000),
  ('model','google/gemini-3.1-flash-lite','tokens.output',1650,1000000)
ON CONFLICT (kind,provider,category) DO NOTHING;
