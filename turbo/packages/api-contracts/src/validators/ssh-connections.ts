import {
  int,
  literal,
  object,
  string,
  union,
  uuid,
  never as zNever,
} from "zod";

import { createCloudflareAccessRequestSchema } from "./cloudflare-access";
import { createTailscaleRequestSchema } from "./tailscale";
import {
  SSH_DISPLAY_NAME_MAX_LENGTH,
  SSH_USERNAME_MAX_LENGTH,
  sshCredentialSelectionSchema,
} from "./ssh-credentials";

export const SSH_HOST_MAX_LENGTH = 253;

const displayNameSchema = string()
  .trim()
  .min(1)
  .max(SSH_DISPLAY_NAME_MAX_LENGTH);
const hostSchema = string().trim().min(1).max(SSH_HOST_MAX_LENGTH);
const portSchema = int().min(1).max(65_535);
const usernameSchema = string().trim().min(1).max(SSH_USERNAME_MAX_LENGTH);
export const accessTransportSchema = object({
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
