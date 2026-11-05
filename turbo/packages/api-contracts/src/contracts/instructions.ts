import { iso, object, strictObject, string, type infer as zInfer } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/** The authenticated member's latest saved Instructions in the active org. */
export const instructionsResponseSchema = object({
  orgId: string().min(1),
  userId: string().min(1),
  content: string(),
  updatedAt: iso.datetime(),
  version: string().min(1),
});

/** Empty content is an intentional clear; omission of ifVersion is a replace. */
export const instructionsRequestSchema = strictObject({
  content: string().refine((content) => {
    return !content.includes("\0");
  }, "Instructions must not contain NUL characters"),
  ifVersion: string().min(1).optional(),
});

/** Personal ownership comes from authentication, never a request target ID. */
export const instructionsContract = c.router({
  get: {
    method: "GET",
    path: "/api/instructions",
    headers: authHeadersSchema,
    responses: {
      200: instructionsResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Read saved personal Instructions",
  },
  update: {
    method: "PUT",
    path: "/api/instructions",
    headers: authHeadersSchema,
    body: instructionsRequestSchema,
    responses: {
      200: instructionsResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Replace personal Instructions, optionally checking their version",
  },
});

export type InstructionsResponse = zInfer<typeof instructionsResponseSchema>;
export type InstructionsRequest = zInfer<typeof instructionsRequestSchema>;
export type InstructionsContract = typeof instructionsContract;
