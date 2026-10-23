import * as z from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const githubInstallationResponseSchema = z.object({
  installation: z.object({
    id: z.string(),
    installationId: z.string().nullable(),
    status: z.string(),
    targetName: z.string().nullable(),
    targetType: z.string().nullable(),
    isAdmin: z.boolean(),
  }),
  isConnected: z.boolean(),
  connectedGithubUserId: z.string().nullable(),
  connectedGithubUsername: z.string().nullable(),
  connectUrl: z.string(),
});

export type GithubInstallationResponse = z.infer<
  typeof githubInstallationResponseSchema
>;

export const githubInstallationNotFoundResponseSchema = apiErrorSchema.extend({
  installUrl: z.string().nullable(),
});

export type GithubInstallationNotFoundResponse = z.infer<
  typeof githubInstallationNotFoundResponseSchema
>;

export const githubIntegrationActionResponseSchema = z.object({
  ok: z.literal(true),
});

export type GithubIntegrationActionResponse = z.infer<
  typeof githubIntegrationActionResponseSchema
>;

export const githubConnectSignatureSchema = z.object({
  installationId: z.string().min(1),
  githubUserId: z.string().min(1),
  githubUsername: z.string().max(255).optional(),
  timestamp: z.number(),
  signature: z.string().min(1),
});

export type GithubConnectSignature = z.infer<
  typeof githubConnectSignatureSchema
>;

export const githubConnectUserBodySchema = z
  .object({
    connectSignature: githubConnectSignatureSchema.optional(),
  })
  .optional();

export type GithubConnectUserBody = z.infer<typeof githubConnectUserBodySchema>;

export const integrationsGithubContract = c.router({
  getInstallation: {
    method: "GET",
    path: "/api/integrations/github",
    headers: authHeadersSchema,
    responses: {
      200: githubInstallationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: githubInstallationNotFoundResponseSchema,
      500: apiErrorSchema,
    },
    summary: "Get the authenticated user's GitHub App installation",
  },

  connectUser: {
    method: "POST",
    path: "/api/integrations/github/link",
    headers: authHeadersSchema,
    body: githubConnectUserBodySchema,
    responses: {
      200: githubIntegrationActionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Link the authenticated Okou user to the GitHub App installation",
  },
});

export type IntegrationsGithubContract = typeof integrationsGithubContract;
