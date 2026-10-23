import * as z from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

import { githubAppSetupCallbackContract } from "./github-oauth-callback";

export {
  githubAppSetupCallbackQuerySchema,
  type GithubAppSetupCallbackQuery,
} from "./github-oauth-callback";

const c = initContract();

const jsonErrorSchema = z.object({ error: z.string() });

export const githubOauthInstallQuerySchema = z.object({
  userId: z.string().optional(),
  orgId: z.string().optional(),
  composeId: z.string().optional(),
});

export const githubOauthConnectQuerySchema = z.object({
  installation: z.string().optional(),
  ghUser: z.string().optional(),
  ghLogin: z.string().optional(),
  ts: z.coerce.number().optional(),
  sig: z.string().optional(),
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
export type GithubOauthInstallQuery = z.infer<
  typeof githubOauthInstallQuerySchema
>;
export type GithubOauthConnectQuery = z.infer<
  typeof githubOauthConnectQuerySchema
>;
