import { coerce, object, string, type infer as zInfer } from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

import { githubAppSetupCallbackContract } from "./github-oauth-callback";

export {
  githubAppSetupCallbackQuerySchema,
  type GithubAppSetupCallbackQuery,
} from "./github-oauth-callback";

const c = initContract();

const jsonErrorSchema = object({ error: string() });

export const githubOauthInstallQuerySchema = object({
  userId: string().optional(),
  orgId: string().optional(),
  composeId: string().optional(),
});

export const githubOauthConnectQuerySchema = object({
  installation: string().optional(),
  ghUser: string().optional(),
  ghLogin: string().optional(),
  ts: coerce.number().optional(),
  sig: string().optional(),
});

export const githubOauthContract = c.router({
  install: {
    method: "GET",
    path: "/api/github/oauth/install",
    query: githubOauthInstallQuerySchema,
    responses: {
      307: c.noBody(),
      503: jsonErrorSchema,
    },
    summary: "Start GitHub App OAuth install",
  },
  connect: {
    method: "GET",
    path: "/api/github/oauth/connect",
    query: githubOauthConnectQuerySchema,
    responses: {
      307: c.noBody(),
      401: apiErrorSchema,
      503: jsonErrorSchema,
    },
    summary: "Start GitHub user OAuth for the GitHub App",
  },
  setupCallback: githubAppSetupCallbackContract.callback,
});

export type GithubOauthContract = typeof githubOauthContract;
export type GithubOauthInstallQuery = zInfer<
  typeof githubOauthInstallQuerySchema
>;
export type GithubOauthConnectQuery = zInfer<
  typeof githubOauthConnectQuerySchema
>;
