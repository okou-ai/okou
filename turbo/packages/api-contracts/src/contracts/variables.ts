import * as z from "zod";

/**
 * Variable response (includes value - key difference from secrets)
 */
export const variableResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  value: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type VariableResponse = z.infer<typeof variableResponseSchema>;

/**
 * List variables response
 */
export const variableListResponseSchema = z.object({
  variables: z.array(variableResponseSchema),
});

export type VariableListResponse = z.infer<typeof variableListResponseSchema>;
