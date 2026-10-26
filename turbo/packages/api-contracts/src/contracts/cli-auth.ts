import { literal, number, object, string } from "zod";
import { initContract, authHeadersSchema } from "./base";

const c = initContract();

/**
 * OAuth-style error response schema for device flow
 * Uses standard OAuth 2.0 error format
 */
const oauthErrorSchema = object({
  error: string(),
  error_description: string(),
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
    body: object({}).optional(),
    responses: {
      200: object({
        device_code: string(),
        user_code: string(),
        verification_path: string(),
        expires_in: number(),
        interval: number(),
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
    body: object({
      device_code: string().min(1, "device_code is required"),
    }),
    responses: {
      // Success - token issued
      200: object({
        access_token: string(),
        token_type: literal("Bearer"),
        expires_in: number(),
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
const apiErrorResponseSchema = object({
  error: object({ message: string(), code: string() }),
});

const cliAuthApproveErrorSchema = object({
  success: literal(false),
  error: string(),
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
    body: object({
      device_code: string().min(1, "device_code is required"),
      timezone: string().min(1).optional(),
    }),
    responses: {
      200: object({ success: literal(true) }),
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
