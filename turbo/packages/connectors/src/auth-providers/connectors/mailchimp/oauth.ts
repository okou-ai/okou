import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { requireConnectorGrantUserId } from "../../grant-result";
import { throwOAuthError } from "../../oauth/error";

const MAILCHIMP_TOKEN_URL = "https://login.mailchimp.com/oauth2/token";

const MAILCHIMP_AUTHORIZATION_URL =
  "https://login.mailchimp.com/oauth2/authorize";

const MAILCHIMP_METADATA_URL = "https://login.mailchimp.com/oauth2/metadata";

interface MailchimpTokenResult {
  accessToken: string;
  scopes: string[];
  apiEndpoint: string;
  userInfo: {
    id: string;
    username: string | null;
    email: string | null;
  };
}

interface MailchimpUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

/**
 * Build Mailchimp OAuth authorization URL.
 * Mailchimp does not use scopes — full account access is granted.
 */
export function buildMailchimpAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });

  return `${MAILCHIMP_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token.
 * After obtaining the token, fetch metadata to get the API endpoint and user info.
 */
export async function exchangeMailchimpCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<MailchimpTokenResult> {
  const response = await fetch(MAILCHIMP_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Mailchimp", "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      error: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(`Mailchimp OAuth error: ${data.error}`);
  }

  if (!data.access_token) {
    throw new Error("No access token in Mailchimp response");
  }

  const metadata = await fetchMailchimpMetadata(data.access_token);

  return {
    accessToken: data.access_token,
    scopes: authCodeGrant.scopes,
    apiEndpoint: metadata.apiEndpoint,
    userInfo: metadata.userInfo,
  };
}

/**
 * Fetch account metadata from Mailchimp OAuth metadata endpoint.
 * Returns the API endpoint (data center) and user info.
 */
async function fetchMailchimpMetadata(accessToken: string): Promise<{
  apiEndpoint: string;
  userInfo: MailchimpUserInfo;
}> {
  const response = await fetch(MAILCHIMP_METADATA_URL, {
    headers: {
      Authorization: `OAuth ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Mailchimp metadata fetch failed: ${response.status} ${await response.text()}`,
    );
  }

  const data = z
    .object({
      dc: z.string().optional(),
      user_id: z.union([z.string(), z.number()]).optional(),
      accountname: z.string().nullable().optional(),
      login: z
        .object({
          login_name: z.string().nullable().optional(),
          login_email: z.string().nullable().optional(),
        })
        .optional(),
      api_endpoint: z.string().optional(),
    })
    .parse(await response.json());

  if (!data.api_endpoint) {
    throw new Error("No API endpoint in Mailchimp metadata response");
  }

  const metadataUserId = data.user_id?.toString();
  // Mailchimp documents metadata for data-center discovery, so tolerate absent `user_id` via the API root's stable `login_id`. Ref: https://mailchimp.com/developer/marketing/guides/access-user-data-oauth-2/ and https://mailchimp.com/developer/marketing/api/root/list-api-root-resources/
  const rootUserInfo = metadataUserId
    ? null
    : await fetchMailchimpRootUserInfo(data.api_endpoint, accessToken);

  return {
    apiEndpoint: data.api_endpoint,
    userInfo: {
      id: requireConnectorGrantUserId(
        metadataUserId ?? rootUserInfo?.id,
        "Mailchimp",
      ),
      username:
        data.login?.login_name ??
        data.accountname ??
        rootUserInfo?.username ??
        null,
      email: data.login?.login_email ?? rootUserInfo?.email ?? null,
    },
  };
}

async function fetchMailchimpRootUserInfo(
  apiEndpoint: string,
  accessToken: string,
): Promise<MailchimpUserInfo> {
  const response = await fetch(`${apiEndpoint}/3.0/`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Mailchimp API root fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      login_id: z.union([z.string(), z.number()]).optional(),
      account_name: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: requireConnectorGrantUserId(data.login_id?.toString(), "Mailchimp"),
    username: data.account_name ?? null,
    email: data.email ?? null,
  };
}
