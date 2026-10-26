import {
  array,
  int,
  literal,
  object,
  string,
  union,
  uuid,
  never as zNever,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { createCloudflareAccessRequestSchema } from "./cloudflare-access";
import { createTailscaleRequestSchema } from "./tailscale";
import { sshConnectionObservationSchema } from "./ssh-connection-observations";
import {
  SSH_DISPLAY_NAME_MAX_LENGTH,
  SSH_USERNAME_MAX_LENGTH,
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

const displayNameSchema = string()
  .trim()
  .min(1)
  .max(SSH_DISPLAY_NAME_MAX_LENGTH);
const hostSchema = string().trim().min(1).max(SSH_HOST_MAX_LENGTH);
const portSchema = int().min(1).max(65_535);
const usernameSchema = string().trim().min(1).max(SSH_USERNAME_MAX_LENGTH);
const accessTransportSchema = object({
  type: literal("cloudflare_access"),
  configId: uuid(),
}).strict();
const tailscaleTransportSchema = object({
  type: literal("tailscale"),
  configId: uuid(),
}).strict();
const credentialConnectionSchema = union([
  object({ type: literal("direct") }).strict(),
  accessTransportSchema,
  tailscaleTransportSchema,
  object({
    type: literal("tailscale"),
    create: createTailscaleRequestSchema,
  }).strict(),
  object({
    type: literal("cloudflare_access"),
    create: createCloudflareAccessRequestSchema,
  }).strict(),
]);
const tailscaleSshConnectionSchema = union([
  object({ type: literal("tailscale_ssh"), configId: uuid() }).strict(),
  object({
    type: literal("tailscale_ssh"),
    create: createTailscaleRequestSchema,
  }).strict(),
]);
// The public API keeps its existing `transport` key for this selection.
const connectionSelectionSchema = union([
  credentialConnectionSchema,
  tailscaleSshConnectionSchema,
]);
const createConnectionFields = {
  id: uuid(),
  displayName: displayNameSchema,
  host: hostSchema,
};
const createCredentialConnectionSchema = object({
  ...createConnectionFields,
  port: portSchema.default(22),
  credential: sshCredentialSelectionSchema,
  username: zNever().optional(),
  transport: credentialConnectionSchema.optional(),
})
  .strict()
  .refine(
    (body) => {
      return body.transport?.type !== "cloudflare_access" || body.port === 443;
    },
    { message: "Cloudflare Access hosts use port 443" },
  );
export const createSshConnectionRequestSchema = union([
  createCredentialConnectionSchema,
  object({
    ...createConnectionFields,
    port: literal(22).default(22),
    credential: zNever().optional(),
    username: usernameSchema,
    transport: tailscaleSshConnectionSchema,
  }).strict(),
]);

export const updateSshConnectionRequestSchema = object({
  expectedGeneration: int().positive().max(2_147_483_647),
  displayName: displayNameSchema.optional(),
  host: hostSchema.optional(),
  port: portSchema.optional(),
  credential: sshCredentialSelectionSchema.optional(),
  username: usernameSchema.optional(),
  transport: connectionSelectionSchema.optional(),
})
  .strict()
  .refine(
    (body) => {
      return (
        body.displayName !== undefined ||
        body.host !== undefined ||
        body.port !== undefined ||
        body.credential !== undefined ||
        body.username !== undefined ||
        body.transport !== undefined
      );
    },
    { message: "At least one SSH connection field must be updated" },
  );

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
