import {
  array,
  int,
  literal,
  object,
  string,
  union,
  uuid,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { sshConnectionObservationSchema } from "./ssh-connection-observations";
import {
  accessTransportSchema,
  createSshConnectionRequestSchema,
  updateSshConnectionRequestSchema,
} from "../validators/ssh-connections";
export {
  SSH_DISPLAY_NAME_MAX_LENGTH,
  SSH_USERNAME_MAX_LENGTH,
  SSH_PRIVATE_KEY_MAX_LENGTH,
  SSH_PASSPHRASE_MAX_LENGTH,
} from "../validators/ssh-credentials";
export {
  SSH_HOST_MAX_LENGTH,
  createSshConnectionRequestSchema,
  updateSshConnectionRequestSchema,
} from "../validators/ssh-connections";

const c = initContract();

export const resetSshConnectionHostKeyRequestSchema = object({
  expectedGeneration: int().positive(),
}).strict();

export const deleteSshConnectionRequestSchema = object({
  expectedGeneration: int().positive().max(2_147_483_647),
}).strict();

export const sshConnectionPathParamsSchema = object({
  connectionId: uuid(),
}).strict();

export const sshConnectionMetadataSchema = object({
  id: uuid(),
  displayName: string(),
  host: string(),
  port: int(),
  username: string(),
  credentialId: uuid(),
  credentialName: string(),
  generation: int().positive(),
  learnedHostKey: object({
    algorithm: string(),
    fingerprint: string(),
  })
    .strict()
    .nullable(),
  createdAt: string().datetime(),
  updatedAt: string().datetime(),
}).strict();

export const sshConnectionResponseSchema = union([
  sshConnectionMetadataSchema
    .omit({ credentialId: true, credentialName: true })
    .extend({
      transport: union([
        object({ type: literal("tailscale_ssh"), configId: uuid() }).strict(),
        object({
          type: literal("tailscale_ssh"),
          needsRebind: literal(true),
        }).strict(),
      ]),
    }),
  sshConnectionMetadataSchema,
  sshConnectionMetadataSchema.extend({ transport: accessTransportSchema }),
  sshConnectionMetadataSchema.extend({
    transport: object({
      type: literal("tailscale"),
      configId: uuid(),
    }).strict(),
  }),
  sshConnectionMetadataSchema.extend({
    transport: object({
      type: literal("tailscale"),
      needsRebind: literal(true),
    }).strict(),
  }),
  sshConnectionMetadataSchema.extend({
    transport: object({
      type: literal("cloudflare_access"),
      needsRebind: literal(true),
    }).strict(),
  }),
]);

export const sshConnectionsListResponseSchema = object({
  connections: array(sshConnectionResponseSchema),
}).strict();

export const sshConnectionsSummaryResponseSchema = object({
  configuredCount: int().nonnegative(),
}).strict();

export const sshConnectionsContract = c.router({
  observations: {
    method: "GET",
    path: "/api/ssh/connections/observations",
    headers: authHeadersSchema,
    responses: {
      200: object({
        observations: array(sshConnectionObservationSchema),
      }).strict(),
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
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
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
    body: deleteSshConnectionRequestSchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
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

export type CreateSshConnectionRequest = zInfer<
  typeof createSshConnectionRequestSchema
>;
export type UpdateSshConnectionRequest = zInfer<
  typeof updateSshConnectionRequestSchema
>;
// A connection mode selects both network access and SSH authentication.
export type SshConnectionMode = NonNullable<
  UpdateSshConnectionRequest["transport"]
>["type"];
export type SshConnectionResponse = zInfer<typeof sshConnectionResponseSchema>;
export type SshConnectionsContract = typeof sshConnectionsContract;
