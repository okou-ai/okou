import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { createCloudflareAccessRequestSchema } from "./cloudflare-access";
import { sshConnectionObservationSchema } from "./ssh-connection-observations";
import {
  SSH_DISPLAY_NAME_MAX_LENGTH,
  sshCredentialSelectionSchema,
} from "./ssh-credentials";
export {
  SSH_DISPLAY_NAME_MAX_LENGTH,
  SSH_USERNAME_MAX_LENGTH,
  SSH_PRIVATE_KEY_MAX_LENGTH,
  SSH_PASSPHRASE_MAX_LENGTH,
} from "./ssh-credentials";

const c = initContract();

export const SSH_HOST_MAX_LENGTH = 253;

const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SSH_DISPLAY_NAME_MAX_LENGTH);
const hostSchema = z.string().trim().min(1).max(SSH_HOST_MAX_LENGTH);
const portSchema = z.int().min(1).max(65_535);
const accessTransportSchema = z
  .object({ type: z.literal("cloudflare_access"), configId: z.uuid() })
  .strict();
const transportSchema = z.union([
  z.object({ type: z.literal("direct") }).strict(),
  accessTransportSchema,
  z
    .object({
      type: z.literal("cloudflare_access"),
      create: createCloudflareAccessRequestSchema,
    })
    .strict(),
]);
export const createSshConnectionRequestSchema = z
  .object({
    displayName: displayNameSchema,
    host: hostSchema,
    port: portSchema.default(22),
    credential: sshCredentialSelectionSchema,
    transport: transportSchema.optional(),
  })
  .strict()
  .refine(
    (body) => {
      return body.transport?.type !== "cloudflare_access" || body.port === 443;
    },
    { message: "Cloudflare Access hosts use port 443" },
  );

export const updateSshConnectionRequestSchema = z
  .object({
    expectedGeneration: z.int().positive().max(2_147_483_647),
    displayName: displayNameSchema.optional(),
    host: hostSchema.optional(),
    port: portSchema.optional(),
    credential: sshCredentialSelectionSchema.optional(),
    transport: transportSchema.optional(),
  })
  .strict()
  .refine(
    (body) => {
      return (
        body.displayName !== undefined ||
        body.host !== undefined ||
        body.port !== undefined ||
        body.credential !== undefined ||
        body.transport !== undefined
      );
    },
    { message: "At least one SSH connection field must be updated" },
  );

export const resetSshConnectionHostKeyRequestSchema = z
  .object({ expectedGeneration: z.int().positive() })
  .strict();

export const sshConnectionPathParamsSchema = z
  .object({ connectionId: z.uuid() })
  .strict();

export const sshConnectionMetadataSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
    host: z.string(),
    port: z.int(),
    username: z.string(),
    credentialId: z.uuid(),
    credentialName: z.string(),
    generation: z.int().positive(),
    learnedHostKey: z
      .object({
        algorithm: z.string(),
        fingerprint: z.string(),
      })
      .strict()
      .nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const sshConnectionResponseSchema = z.union([
  sshConnectionMetadataSchema,
  sshConnectionMetadataSchema.extend({ transport: accessTransportSchema }),
]);

export const sshConnectionsListResponseSchema = z
  .object({ connections: z.array(sshConnectionResponseSchema) })
  .strict();

export const sshConnectionsSummaryResponseSchema = z
  .object({ configuredCount: z.int().nonnegative() })
  .strict();

export const sshConnectionsContract = c.router({
  observations: {
    method: "GET",
    path: "/api/ssh/connections/observations",
    headers: authHeadersSchema,
    responses: {
      200: z
        .object({ observations: z.array(sshConnectionObservationSchema) })
        .strict(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Read the owner's latest SSH connection observations",
  },
  list: {
    method: "GET",
    path: "/api/ssh/connections",
    headers: authHeadersSchema,
    responses: {
      200: sshConnectionsListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List SSH connections",
  },
  summary: {
    method: "GET",
    path: "/api/ssh/connections/summary",
    headers: authHeadersSchema,
    responses: {
      200: sshConnectionsSummaryResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Summarize SSH connection configuration",
  },
  create: {
    method: "POST",
    path: "/api/ssh/connections",
    headers: authHeadersSchema,
    body: createSshConnectionRequestSchema,
    responses: {
      201: sshConnectionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create an SSH connection",
  },
  update: {
    method: "PATCH",
    path: "/api/ssh/connections/:connectionId",
    headers: authHeadersSchema,
    pathParams: sshConnectionPathParamsSchema,
    body: updateSshConnectionRequestSchema,
    responses: {
      200: sshConnectionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update an SSH connection",
  },
  delete: {
    method: "DELETE",
    path: "/api/ssh/connections/:connectionId",
    headers: authHeadersSchema,
    pathParams: sshConnectionPathParamsSchema,
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete an SSH connection",
  },
  resetHostKey: {
    method: "POST",
    path: "/api/ssh/connections/:connectionId/reset-host-key",
    headers: authHeadersSchema,
    pathParams: sshConnectionPathParamsSchema,
    body: resetSshConnectionHostKeyRequestSchema,
    responses: {
      200: sshConnectionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Reset a learned SSH host key",
  },
});

export type CreateSshConnectionRequest = z.infer<
  typeof createSshConnectionRequestSchema
>;
export type UpdateSshConnectionRequest = z.infer<
  typeof updateSshConnectionRequestSchema
>;
export type SshConnectionResponse = z.infer<typeof sshConnectionResponseSchema>;
export type SshConnectionsContract = typeof sshConnectionsContract;
