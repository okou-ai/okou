import { object, string, type infer as Infer } from "zod";

/**
 * Standard API error response schema
 * Used across all API endpoints for consistent error handling
 */
export const apiErrorSchema = object({
  error: object({
    message: string(),
    code: string(),
  }),
});

export type ApiErrorResponse = Infer<typeof apiErrorSchema>;
