import {
  discriminatedUnion,
  literal,
  object,
  string,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";

const c = initContract();

export const connectorOauthCallbackResultSchema = discriminatedUnion("status", [
  object({
    status: literal("success"),
    username: string().nullable(),
  }),
  object({
    status: literal("error"),
    message: string(),
  }),
]);

export type ConnectorOauthCallbackResult = zInfer<
  typeof connectorOauthCallbackResultSchema
>;

export const builtinConnectorsSlugCallbackContract = c.router({
  callback: {
    method: "GET",
    path: "/api/connectors/:connectorSlug/callback",
    headers: authHeadersSchema,
    pathParams: object({ connectorSlug: connectorSlugSchema }),
    query: object({
      code: string().optional(),
      auth_code: string().optional(),
      state: string().optional(),
      realmId: string().optional(),
      error: string().optional(),
      error_description: string().optional(),
      responseMode: literal("json").optional(),
      "openid.mode": string().optional(),
      "openid.ns": string().optional(),
      "openid.op_endpoint": string().optional(),
      "openid.claimed_id": string().optional(),
      "openid.identity": string().optional(),
      "openid.return_to": string().optional(),
      "openid.response_nonce": string().optional(),
      "openid.assoc_handle": string().optional(),
      "openid.signed": string().optional(),
      "openid.sig": string().optional(),
      "openid.realm": string().optional(),
    }).catchall(string()),
    responses: {
      200: connectorOauthCallbackResultSchema,
      307: c.noBody(),
    },
    summary: "Complete connector browser authorization",
  },
});

export type BuiltinConnectorsSlugCallbackContract =
  typeof builtinConnectorsSlugCallbackContract;
