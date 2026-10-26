import * as z from "zod";

/**
 * Standard API error response schema
 * Used across all API endpoints for consistent error handling
 */
export const apiErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.string(),
  }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;
