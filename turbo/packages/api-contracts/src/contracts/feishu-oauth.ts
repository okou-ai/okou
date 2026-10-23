import * as z from "zod";

import { initContract } from "./base";

const c = initContract();

const jsonErrorSchema = z.object({ error: z.string() });

export const feishuOauthConnectQuerySchema = z.object({
  callbackTarget: z.literal("app").optional(),
  state: z.string().optional(),
});

export const feishuOauthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  responseMode: z.literal("json").optional(),
  state: z.string().optional(),
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
      200: z.object({ redirectUrl: z.url() }),
      307: c.noBody(),
      400: jsonErrorSchema,
    },
    summary: "Handle Feishu user OAuth callback",
  },
});

export type FeishuOauthContract = typeof feishuOauthContract;
