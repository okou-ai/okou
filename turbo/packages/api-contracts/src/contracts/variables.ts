import { array, object, string, uuid, type infer as zInfer } from "zod";

/**
 * Variable response (includes value - key difference from secrets)
 */
export const variableResponseSchema = object({
  id: uuid(),
  name: string(),
  value: string(),
  description: string().nullable(),
  createdAt: string(),
  updatedAt: string(),
});

export type VariableResponse = zInfer<typeof variableResponseSchema>;

/**
 * List variables response
 */
export const variableListResponseSchema = object({
  variables: array(variableResponseSchema),
});

export type VariableListResponse = zInfer<typeof variableListResponseSchema>;
