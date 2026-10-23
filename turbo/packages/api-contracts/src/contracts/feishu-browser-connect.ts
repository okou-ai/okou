import * as z from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const feishuConnectTokenSchema = z.object({
  installationId: z.string().uuid(),
  openId: z.string().min(1),
  chatId: z.string().min(1),
  ts: z.coerce.number().int(),
  sig: z.string().min(1),
});

export const feishuBrowserConnectContract = c.router({
  connect: {
    method: "GET",
    path: "/api/feishu/connect",
    query: feishuConnectTokenSchema.partial(),
    responses: {
      307: c.noBody(),
      500: z.object({ error: z.string() }),
    },
    summary: "Connect a Feishu user from a legacy direct message link",
  },
  connectFromApp: {
    method: "POST",
    path: "/api/feishu/connect",
    headers: authHeadersSchema,
    body: feishuConnectTokenSchema,
    responses: {
      200: z.object({
        success: z.literal(true),
        botName: z.string().nullable(),
        openUrl: z.url(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Connect a Feishu user from the product app",
  },
  getStatus: {
    method: "GET",
    path: "/api/feishu/connect/status",
    headers: authHeadersSchema,
    query: feishuConnectTokenSchema,
    responses: {
      200: z.object({
        isConnected: z.boolean(),
        botName: z.string().nullable(),
        openUrl: z.url(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Check whether a Feishu user is connected",
  },
});

export type FeishuBrowserConnectContract = typeof feishuBrowserConnectContract;
