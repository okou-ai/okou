import * as z from "zod";
import { initContract, authHeadersSchema } from "./base";

const c = initContract();

/**
 * OAuth-style error response schema for device flow
 * Uses standard OAuth 2.0 error format
 */
const oauthErrorSchema = z.object({
  error: z.string(),
  error_description: z.string(),
});

/**
 * CLI auth device contract for /api/cli/auth/device
 */
export const cliAuthDeviceContract = c.router({
  /**
   * POST /api/cli/auth/device
   * Initiate device authorization flow
   */
  create: {
    method: "POST",
    path: "/api/cli/auth/device",
    body: z.object({}).optional(),
    responses: {
      200: z.object({
        device_code: z.string(),
        user_code: z.string(),
        verification_path: z.string(),
        expires_in: z.number(),
        interval: z.number(),
      }),
      500: oauthErrorSchema,
    },
    summary: "Initiate device authorization flow",
  },
});

/**
 * CLI auth token contract for /api/cli/auth/token
 */
export const cliAuthTokenContract = c.router({
  /**
   * POST /api/cli/auth/token
   * Exchange device code for access token
   */
  exchange: {
    method: "POST",
    path: "/api/cli/auth/token",
    body: z.object({
      device_code: z.string().min(1, "device_code is required"),
    }),
    responses: {
      // Success - token issued
      200: z.object({
        access_token: z.string(),
        token_type: z.literal("Bearer"),
        expires_in: z.number(),
      }),
      // Authorization pending
      202: oauthErrorSchema,
      // Various error states
      400: oauthErrorSchema,
      500: oauthErrorSchema,
    },
    summary: "Exchange device code for access token",
  },
});

/**
 * Error response schema for structured API errors
 */
const apiErrorResponseSchema = z.object({
  error: z.object({ message: z.string(), code: z.string() }),
});

const cliAuthApproveErrorSchema = z.object({
  success: z.literal(false),
  error: z.string(),
});

/**
 * CLI auth browser approval contract for /api/cli/auth/approve
 */
export const cliAuthApproveContract = c.router({
  /**
   * POST /api/cli/auth/approve
   * Approve a pending CLI device code from a browser session
   */
  approve: {
    method: "POST",
    path: "/api/cli/auth/approve",
    headers: authHeadersSchema,
    body: z.object({
      device_code: z.string().min(1, "device_code is required"),
      timezone: z.string().min(1).optional(),
    }),
    responses: {
      200: z.object({ success: z.literal(true) }),
      400: cliAuthApproveErrorSchema,
      401: apiErrorResponseSchema,
      403: apiErrorResponseSchema,
    },
    summary: "Approve a CLI device authorization flow",
  },
});

export type CliAuthDeviceContract = typeof cliAuthDeviceContract;
export type CliAuthTokenContract = typeof cliAuthTokenContract;
export type CliAuthApproveContract = typeof cliAuthApproveContract;
