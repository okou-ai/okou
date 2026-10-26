import { number, object, string, type infer as zInfer } from "zod";

import { ProviderHttpError, ProviderResponseError } from "../../provider-error";

const LARK_TENANT_ACCESS_TOKEN_URL =
  "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal";

const larkTenantAccessTokenResponseSchema = object({
  code: number(),
  msg: string().optional(),
  tenant_access_token: string().optional(),
  expire: number().optional(),
});

type LarkTenantAccessTokenResponse = zInfer<
  typeof larkTenantAccessTokenResponseSchema
>;

interface LarkTenantAccessTokenResult {
  readonly accessToken: string;
  readonly expiresIn: number;
}

export async function fetchLarkTenantAccessToken(
  args: {
    readonly appId: string;
    readonly appSecret: string;
  },
  signal: AbortSignal,
): Promise<LarkTenantAccessTokenResult> {
  const response = await fetch(LARK_TENANT_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      app_id: args.appId,
      app_secret: args.appSecret,
    }),
    signal,
  });

  if (!response.ok) {
    throw new ProviderHttpError(
      `Lark tenant access token request failed: ${response.status}`,
      response.status,
    );
  }

  const data = await readLarkTenantAccessTokenResponse(response);

  if (data.code !== 0) {
    throw new Error(data.msg ?? `Lark tenant access token error ${data.code}`);
  }
  if (!data.tenant_access_token) {
    throw new ProviderResponseError("Missing Lark tenant access token");
  }
  if (data.expire === undefined || data.expire <= 0) {
    throw new ProviderResponseError("Missing Lark tenant access token expiry");
  }

  return {
    accessToken: data.tenant_access_token,
    expiresIn: data.expire,
  };
}

async function readLarkTenantAccessTokenResponse(
  response: Response,
): Promise<LarkTenantAccessTokenResponse> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ProviderResponseError(
      "Invalid Lark tenant access token response",
    );
  }

  const parsed = larkTenantAccessTokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ProviderResponseError(
      "Invalid Lark tenant access token response",
    );
  }
  return parsed.data;
}
