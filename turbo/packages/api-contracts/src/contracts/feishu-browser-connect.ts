import { boolean, coerce, literal, object, string, url, uuid } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const feishuConnectTokenSchema = object({
  installationId: uuid(),
  openId: string().min(1),
  chatId: string().min(1),
  ts: coerce.number().int(),
  sig: string().min(1),
});

export const feishuBrowserConnectContract = c.router({
  connect: {
    method: "GET",
    path: "/api/feishu/connect",
    query: feishuConnectTokenSchema.partial(),
    responses: {
      307: c.noBody(),
      500: object({ error: string() }),
    },
    summary: "Connect a Feishu user from a legacy direct message link",
  },
  connectFromApp: {
    method: "POST",
    path: "/api/feishu/connect",
    headers: authHeadersSchema,
    body: feishuConnectTokenSchema,
    responses: {
      200: object({
        success: literal(true),
        botName: string().nullable(),
        openUrl: url(),
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
      200: object({
        isConnected: boolean(),
        botName: string().nullable(),
        openUrl: url(),
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
