import { literal, object, type infer as zInfer } from "zod";

/**
 * Admission-time mode carried by the server-signed Okou Run token. The producer
 * derives it from the singleAgent switch and the authorized default executor.
 * Absence identifies legacy Runs, including tokens issued before this field.
 * This is execution context, not an independent switch or an authorization grant.
 */
export const singleAgentRuntimeContextSchema = object({
  singleAgent: literal(true).optional(),
});

export type SingleAgentRuntimeContext = zInfer<
  typeof singleAgentRuntimeContextSchema
>;
