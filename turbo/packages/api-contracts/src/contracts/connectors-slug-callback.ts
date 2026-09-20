import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";

const c = initContract();

export const connectorOauthCallbackResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("success"),
      username: z.string().nullable(),
    }),
    z.object({
      status: z.literal("error"),
      message: z.string(),
    }),
  ],
);

export type ConnectorOauthCallbackResult = z.infer<
  typeof connectorOauthCallbackResultSchema
>;

export const builtinConnectorsSlugCallbackContract = c.router({
  callback: {
    method: "GET",
    path: "/api/connectors/:connectorSlug/callback",
    headers: authHeadersSchema,
    pathParams: z.object({ connectorSlug: connectorSlugSchema }),
    query: z
      .object({
        code: z.string().optional(),
        auth_code: z.string().optional(),
        state: z.string().optional(),
        realmId: z.string().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
        responseMode: z.literal("json").optional(),
        "openid.mode": z.string().optional(),
        "openid.ns": z.string().optional(),
        "openid.op_endpoint": z.string().optional(),
        "openid.claimed_id": z.string().optional(),
        "openid.identity": z.string().optional(),
        "openid.return_to": z.string().optional(),
        "openid.response_nonce": z.string().optional(),
        "openid.assoc_handle": z.string().optional(),
        "openid.signed": z.string().optional(),
        "openid.sig": z.string().optional(),
        "openid.realm": z.string().optional(),
      })
      .catchall(z.string()),
    responses: {
      200: connectorOauthCallbackResultSchema,
      307: c.noBody(),
    },
    summary: "Complete connector browser authorization",
  },
});

export type BuiltinConnectorsSlugCallbackContract =
  typeof builtinConnectorsSlugCallbackContract;
