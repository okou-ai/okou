import { literal, object, string, url } from "zod";

import { initContract } from "./base";

const c = initContract();

const jsonErrorSchema = object({ error: string() });

export const feishuOauthConnectQuerySchema = object({
  callbackTarget: literal("app").optional(),
  state: string().optional(),
});

export const feishuOauthCallbackQuerySchema = object({
  code: string().optional(),
  error: string().optional(),
  error_description: string().optional(),
  responseMode: literal("json").optional(),
  state: string().optional(),
});

export const feishuOauthContract = c.router({
  connect: {
    method: "GET",
    path: "/api/feishu/oauth/connect",
    query: feishuOauthConnectQuerySchema,
    responses: {
      307: c.noBody(),
      400: jsonErrorSchema,
    },
    summary: "Start Feishu user OAuth connect",
  },
  callback: {
    method: "GET",
    path: "/api/integrations/feishu/oauth/callback",
    query: feishuOauthCallbackQuerySchema,
    responses: {
      200: object({ redirectUrl: url() }),
      307: c.noBody(),
      400: jsonErrorSchema,
    },
    summary: "Handle Feishu user OAuth callback",
  },
});

export type FeishuOauthContract = typeof feishuOauthContract;
