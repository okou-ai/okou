import { literal, object, type infer as zInfer } from "zod";

/**
 * Personal-execution marker on the server-signed Okou Run token. Every Run is
 * personal execution now, so the API no longer consults this claim: a Run
 * token is authorized the same way whether or not it carries the claim.
 *
 * The producer still emits it for the previous API build, which rejects
 * personal Instructions and Project requests from a Run token without the
 * claim and can still serve during promotion or after a rollback. Stop emitting
 * the claim and delete this schema once that build is neither serving nor
 * retained as a rollback target:
 * https://github.com/okou-ai/okou/issues/45476
 */
export const singleAgentRuntimeContextSchema = object({
  singleAgent: literal(true).optional(),
});

export type SingleAgentRuntimeContext = zInfer<
  typeof singleAgentRuntimeContextSchema
>;
