import {
  boolean,
  literal,
  number,
  object,
  string,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const githubInstallationResponseSchema = object({
  installation: object({
    id: string(),
    installationId: string().nullable(),
    status: string(),
    targetName: string().nullable(),
    targetType: string().nullable(),
    isAdmin: boolean(),
  }),
  isConnected: boolean(),
  connectedGithubUserId: string().nullable(),
  connectedGithubUsername: string().nullable(),
  connectUrl: string(),
});

export type GithubInstallationResponse = zInfer<
  typeof githubInstallationResponseSchema
>;

export const githubInstallationNotFoundResponseSchema = apiErrorSchema.extend({
  installUrl: string().nullable(),
});

export type GithubInstallationNotFoundResponse = zInfer<
  typeof githubInstallationNotFoundResponseSchema
>;

export const githubIntegrationActionResponseSchema = object({
  ok: literal(true),
});

export type GithubIntegrationActionResponse = zInfer<
  typeof githubIntegrationActionResponseSchema
>;

export const githubConnectSignatureSchema = object({
  installationId: string().min(1),
  githubUserId: string().min(1),
  githubUsername: string().max(255).optional(),
  timestamp: number(),
  signature: string().min(1),
});

export type GithubConnectSignature = zInfer<
  typeof githubConnectSignatureSchema
>;

export const githubConnectUserBodySchema = object({
  connectSignature: githubConnectSignatureSchema.optional(),
}).optional();

export type GithubConnectUserBody = zInfer<typeof githubConnectUserBodySchema>;

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
