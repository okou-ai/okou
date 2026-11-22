import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Claimed before contacting Vertex. A checkpoint can be settled again after disconnect. */
export const voiceTranscriptions = pgTable("voice_transcriptions", {
  id: uuid("id").primaryKey(),
  userId: text("user_id").notNull(),
  orgId: text("org_id").notNull(),
  runId: uuid("run_id"),
  requestHash: text("request_hash").notNull(),
  transcript: text("transcript"),
  audioTokens: integer("audio_tokens"),
  textTokens: integer("text_tokens"),
  cachedTextTokens: integer("cached_text_tokens"),
  cachedAudioTokens: integer("cached_audio_tokens"),
  outputTokens: integer("output_tokens"),
  settledAt: timestamp("settled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
