import {
  discriminatedUnion,
  int,
  iso,
  literal,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { cloudflareAccessCredentialsSchema } from "./cloudflare-access";
import { tailscaleCredentialsSchema, tailscaleTagsSchema } from "./tailscale";
import {
  sshAuthenticationSchema,
  SSH_PASSWORD_MAX_LENGTH,
} from "./ssh-credentials";
import { runnerHeartbeatGenerationSchema } from "./runner-primitives";
import { sshConnectionFailureReasonSchema } from "./ssh-connection-observations";
import {
  SSH_HOST_MAX_LENGTH,
  SSH_PASSPHRASE_MAX_LENGTH,
  SSH_PRIVATE_KEY_MAX_LENGTH,
  SSH_USERNAME_MAX_LENGTH,
} from "./ssh-connections";

export { SSH_PASSWORD_MAX_LENGTH } from "./ssh-credentials";
const c = initContract();
const generationSchema = int().positive().max(2_147_483_647);

/** Identifier-only invalidation; null connectionId invalidates the whole Run. */
export const runnerSshInvalidateSchema = object({
  runId: uuid(),
  connectionId: uuid().nullable(),
}).strict();

export type RunnerSshInvalidate = zInfer<typeof runnerSshInvalidateSchema>;

export const sshHostKeySchema = object({
  // RSA key identity is ssh-rsa; the Runner must use SHA-2 signatures.
  algorithm: zEnum([
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "ssh-rsa",
  ]),
  fingerprint: string().regex(/^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/u),
}).strict();

const resolveRequestSchema = object({
  connectionId: uuid(),
  runnerIdentity: object({
    runnerId: uuid(),
    heartbeatGeneration: runnerHeartbeatGenerationSchema,
  }).strict(),
}).strict();

const unavailableSchema = object({ outcome: literal("unavailable") }).strict();
const resolvedFields = {
  host: string().min(1).max(SSH_HOST_MAX_LENGTH),
  port: int().min(1).max(65_535),
  username: string().min(1).max(SSH_USERNAME_MAX_LENGTH),
  generation: generationSchema,
  learnedHostKey: sshHostKeySchema.nullable(),
};
export const runnerSshAccessResolvedSchema = object({
  outcome: literal("resolved_access"),
  ...resolvedFields,
  authentication: sshAuthenticationSchema,
  access: cloudflareAccessCredentialsSchema.extend({
    configId: uuid(),
    generation: generationSchema,
  }),
}).strict();
export const runnerSshTailscaleResolvedSchema = object({
  outcome: literal("resolved_tailscale"),
  ...resolvedFields,
  authentication: sshAuthenticationSchema,
  tailscale: tailscaleCredentialsSchema.extend({
    configId: uuid(),
    generation: generationSchema,
    tags: tailscaleTagsSchema,
  }),
}).strict();
const resolveResponseSchema = discriminatedUnion("outcome", [
  unavailableSchema,
  object({
    outcome: literal("resolved"),
    ...resolvedFields,
    privateKey: string().min(1).max(SSH_PRIVATE_KEY_MAX_LENGTH),
    passphrase: string().min(1).max(SSH_PASSPHRASE_MAX_LENGTH).nullable(),
  }).strict(),
  object({
    outcome: literal("resolved_password"),
    ...resolvedFields,
    password: string().min(1).max(SSH_PASSWORD_MAX_LENGTH),
  }).strict(),
  runnerSshAccessResolvedSchema,
  runnerSshTailscaleResolvedSchema,
  runnerSshTailscaleResolvedSchema
    .omit({ authentication: true })
    .extend({
      outcome: literal("resolved_tailscale_ssh"),
    })
    .refine(
      (body) => {
        return body.port === 22;
      },
      {
        message: "Tailscale SSH uses port 22",
      },
    ),
]);

const pinRequestSchema = resolveRequestSchema
  .extend({
    expectedGeneration: generationSchema,
    observedHostKey: sshHostKeySchema,
  })
  .strict();

const pinResponseSchema = discriminatedUnion("outcome", [
  unavailableSchema,
  object({ outcome: literal("pinned"), generation: generationSchema }).strict(),
  object({
    outcome: literal("matched"),
    generation: generationSchema,
  }).strict(),
  object({ outcome: literal("host_key_mismatch") }).strict(),
  object({ outcome: literal("configuration_changed") }).strict(),
]);

export const runnerSshContract = c.router({
  observe: {
    method: "POST",
    path: "/api/runners/runs/:runId/ssh/observations",
    pathParams: object({ runId: uuid() }).strict(),
    headers: authHeadersSchema,
    body: resolveRequestSchema
      .extend({
        expectedGeneration: generationSchema,
        expectedCreatedAt: iso.datetime(),
        observedAt: iso.datetime(),
        failureReason: sshConnectionFailureReasonSchema.nullable(),
      })
      .strict(),
    responses: {
      200: object({
        outcome: zEnum(["recorded", "ignored", "unavailable"]),
      }).strict(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Record bounded SSH connection evidence from the winning Runner",
  },
  resolve: {
    method: "POST",
    path: "/api/runners/runs/:runId/ssh/resolve",
    pathParams: object({ runId: uuid() }).strict(),
    headers: authHeadersSchema,
    body: resolveRequestSchema,
    responses: {
      200: resolveResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Resolve one current SSH credential for the winning official Runner",
  },
  pin: {
    method: "POST",
    path: "/api/runners/runs/:runId/ssh/pin",
    pathParams: object({ runId: uuid() }).strict(),
    headers: authHeadersSchema,
    body: pinRequestSchema,
    responses: {
      200: pinResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Atomically learn an SSH host key under current Run authority",
  },
});

export type RunnerSshResolveRequest = zInfer<typeof resolveRequestSchema>;
export type RunnerSshResolveResponse = zInfer<typeof resolveResponseSchema>;
export type RunnerSshPinRequest = zInfer<typeof pinRequestSchema>;
export type RunnerSshPinResponse = zInfer<typeof pinResponseSchema>;
export type RunnerSshObservationRequest = zInfer<
  typeof runnerSshContract.observe.body
>;
