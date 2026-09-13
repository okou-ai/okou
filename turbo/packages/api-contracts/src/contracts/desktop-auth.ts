import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const desktopAuthCallbackSchemes = [
  "ai.okou.desktop",
  "ai.okou.desktop.dev",
] as const;
export const desktopAuthCallbackSchemeSchema = z.enum(
  desktopAuthCallbackSchemes,
);
export type DesktopAuthCallbackScheme = z.infer<
  typeof desktopAuthCallbackSchemeSchema
>;
/**
 * Only a body-less caller reaches this default; every packaged Desktop build
 * sends its own scheme. Name the production identity explicitly so reordering
 * the accepted set cannot retarget the callback URL.
 */
export const defaultDesktopAuthCallbackScheme: DesktopAuthCallbackScheme =
  "ai.okou.desktop";

export const desktopAuthHandoffStatusSchema = z.enum([
  "pending",
  "consumed",
  "completed",
]);
export type DesktopAuthHandoffStatus = z.infer<
  typeof desktopAuthHandoffStatusSchema
>;

const desktopAuthHandoffPathParamsSchema = z.object({
  handoffId: z.string().uuid(),
});

export const desktopAuthHandoffContract = c.router({
  create: {
    method: "POST",
    path: "/api/desktop-auth/handoff",
    headers: authHeadersSchema,
    body: z
      .object({
        callbackScheme: desktopAuthCallbackSchemeSchema.optional(),
      })
      .optional(),
    responses: {
      200: z.object({
        callbackUrl: z.string(),
        handoffId: z.string().uuid(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create a desktop auth handoff code",
  },
  status: {
    method: "GET",
    path: "/api/desktop-auth/handoff/:handoffId",
    pathParams: desktopAuthHandoffPathParamsSchema,
    headers: authHeadersSchema,
    responses: {
      200: z.object({
        status: desktopAuthHandoffStatusSchema,
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Read desktop auth handoff status",
  },
  complete: {
    method: "POST",
    path: "/api/desktop-auth/handoff/:handoffId/complete",
    pathParams: desktopAuthHandoffPathParamsSchema,
    headers: authHeadersSchema,
    body: z.object({}).optional(),
    responses: {
      200: z.object({
        status: z.literal("completed"),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Mark desktop auth handoff complete",
  },
});

export const desktopAuthConsumeContract = c.router({
  consume: {
    method: "POST",
    path: "/api/desktop-auth/consume",
    body: z.object({
      code: z.string().min(1, "code is required"),
    }),
    responses: {
      200: z.object({
        token: z.string(),
      }),
      400: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Consume a desktop auth handoff code",
  },
});

export type DesktopAuthHandoffContract = typeof desktopAuthHandoffContract;
export type DesktopAuthConsumeContract = typeof desktopAuthConsumeContract;
