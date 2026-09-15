import { createHash, randomUUID } from "node:crypto";

import type { ConnectorAuthMethodId } from "@okouai/api-contracts/contracts/connector-identity";
import { connectorOauthStartResponseSchema } from "@okouai/api-contracts/contracts/connector-schemas";
import { http, HttpResponse, type JsonBodyType } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { clearMockNow } from "../../../lib/time";
import {
  API_TEST_CONNECTOR_CATALOG,
  installApiTestConnectorCatalog,
} from "../../../test-fixtures/connector-catalog";
import { connectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { connectorsRoutes } from "../connectors";
import { createRouteMocks } from "./helpers/route-test";

const TEST_APP_ROUTES = Object.freeze([
  ...connectorsSlugCallbackRoutes,
  ...connectorsRoutes,
]);

const context = testContext();
const mocks = createRouteMocks(context);

const BASE_URL = "https://app.okou.test";
const API_ORIGIN = "https://api.okou.ai";
const WEB_ORIGIN = "https://www.okou.ai";
const LOCAL_ORIGIN = "http://localhost:3000";
const LOCAL_WEB_ORIGIN = "https://www.okou.ai:8443";
const ASANA_OAUTH_TOKEN_URL = "https://app.asana.com/-/oauth_token";
const BOX_OAUTH_TOKEN_URL = "https://api.box.com/oauth2/token";
const BOX_CURRENT_USER_URL = "https://api.box.com/2.0/users/me";
const CLOUDFLARE_OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const CLOUDFLARE_USERINFO_URL = "https://dash.cloudflare.com/oauth2/userinfo";
const GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_OAUTH_SCOPES = ["repo", "project", "workflow"] as const;
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_OPENID_USERINFO_URL =
  "https://openidconnect.googleapis.com/v1/userinfo";
const GUMROAD_OAUTH_TOKEN_URL = "https://gumroad.com/oauth/token";
const GUMROAD_USER_URL = "https://api.gumroad.com/v2/user";
const HUBSPOT_OAUTH_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const HUBSPOT_TOKEN_INFO_URL = "https://api.hubapi.com/oauth/v1/access-tokens";
const INTERVALS_ICU_OAUTH_TOKEN_URL = "https://intervals.icu/api/oauth/token";
const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const META_ADS_OAUTH_TOKEN_URL =
  "https://graph.facebook.com/v22.0/oauth/access_token";
const META_ADS_USER_URL = "https://graph.facebook.com/v22.0/me";
const MONDAY_OAUTH_TOKEN_URL = "https://auth.monday.com/oauth2/token";
const MONDAY_GRAPHQL_URL = "https://api.monday.com/v2";
const NOTION_OAUTH_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const QUICKBOOKS_OAUTH_TOKEN_URL =
  "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QUICKBOOKS_USERINFO_URL =
  "https://accounts.platform.intuit.com/v1/openid_connect/userinfo";
const SENTRY_OAUTH_TOKEN_URL = "https://sentry.io/oauth/token/";
const STRAVA_OAUTH_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_ATHLETE_URL = "https://www.strava.com/api/v3/athlete";
const STRIPE_OAUTH_TOKEN_URL = "https://api.stripe.com/v1/oauth/token";
const STRIPE_ACCOUNT_URL = "https://api.stripe.com/v1/account";
const TIKTOK_ADS_OAUTH_TOKEN_URL =
  "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/";
const TODOIST_OAUTH_TOKEN_URL = "https://todoist.com/oauth/access_token";
const TODOIST_USER_URL = "https://api.todoist.com/api/v1/user";
const VERCEL_OAUTH_TOKEN_URL = "https://api.vercel.com/v2/oauth/access_token";
const VERCEL_USER_URL = "https://api.vercel.com/v2/user";
// Stubbed at module-load time by src/__tests__/env-stub.ts.
const VERCEL_INTEGRATION_SLUG = "okou-test-integration";
const X_OAUTH_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const X_USERS_ME_URL = "https://api.x.com/2/users/me";
const XERO_OAUTH_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_USERINFO_URL = "https://identity.xero.com/connect/userinfo";
const AIRTABLE_OAUTH_TOKEN_URL = "https://airtable.com/oauth2/v1/token";
const AIRTABLE_WHOAMI_URL = "https://api.airtable.com/v0/meta/whoami";
const AUTH_REQUEST_USER_ID_PREFIX = "user_okou_connectors_oauth_start_";
const YOUTUBE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

function oauthStartUrl(connectorSlug: string, origin = BASE_URL): string {
  return new URL(
    `/api/connectors/${connectorSlug}/oauth/start`,
    origin,
  ).toString();
}

function authHeaders(): Record<string, string> {
  return { authorization: "Bearer clerk-session" };
}

function mockAuthenticatedSession(): void {
  mocks.clerk.session(
    `${AUTH_REQUEST_USER_ID_PREFIX}${randomUUID()}`,
    `org_${randomUUID()}`,
  );
}

// #30570 pre-stages twenty launch-gated OAuth connectors on the direct Okou App
// callback. Each case pins the provider-specific authorization and token
// exchange contract that must survive the callback change.
type LaunchGatedDirectOkouCase = {
  readonly connectorSlug: string;
  readonly label: string;
  readonly authorizationEndpoint: string;
  readonly tokenUrl: string;
  readonly tokenResponse: JsonBodyType;
  // The authorization URL carries a PKCE challenge and the token exchange
  // replays the verifier.
  readonly pkce?: true;
  // The provider rejects a redirect URI on the token request.
  readonly omitsTokenRedirectUri?: true;
  // Webflow posts a JSON token request instead of a form body.
  readonly jsonTokenRequest?: true;
  // Datadog resolves its token host from a callback query parameter.
  readonly callbackQuery?: Readonly<Record<string, string>>;
  readonly mockUserInfo?: () => void;
} & (
  | { readonly clientEnvPrefix: string }
  | { readonly publicClientId: string }
);

const LAUNCH_GATED_DIRECT_OKOU_CASES: readonly LaunchGatedDirectOkouCase[] = [
  {
    connectorSlug: "ahrefs",
    label: "Ahrefs",
    clientEnvPrefix: "AHREFS",
    authorizationEndpoint: "https://app.ahrefs.com/api/auth",
    tokenUrl: "https://app.ahrefs.com/api/token",
    tokenResponse: {
      access_token: "ahrefs-test-token",
      refresh_token: "ahrefs-refresh-token",
      expires_in: 3600,
    },
    mockUserInfo: () => {
      server.use(
        http.get(
          "https://api.ahrefs.com/v3/subscription-info/limits-and-usage",
          () => {
            return HttpResponse.json({
              subscription: { usage_type: "Enterprise" },
              rows_limit: 1000,
              rows_left: 900,
            });
          },
        ),
      );
    },
  },
  {
    connectorSlug: "cal-com",
    label: "Cal.com",
    clientEnvPrefix: "CAL_COM",
    authorizationEndpoint: "https://app.cal.com/auth/oauth2/authorize",
    tokenUrl: "https://api.cal.com/v2/auth/oauth2/token",
    tokenResponse: {
      access_token: "cal-com-test-token",
      refresh_token: "cal-com-refresh-token",
      expires_in: 3600,
    },
    mockUserInfo: () => {
      server.use(
        http.get("https://api.cal.com/v2/me", () => {
          return HttpResponse.json({
            data: {
              id: "cal-com-user-123",
              username: "cal-com-test-user",
              email: "cal-com@example.test",
            },
          });
        }),
      );
    },
  },
  {
    connectorSlug: "calendly",
    label: "Calendly",
    clientEnvPrefix: "CALENDLY",
    authorizationEndpoint: "https://auth.calendly.com/oauth/authorize",
    tokenUrl: "https://auth.calendly.com/oauth/token",
    pkce: true,
    jsonTokenRequest: true,
    tokenResponse: {
      token_type: "Bearer",
      access_token: "calendly-test-token",
      refresh_token: "calendly-refresh-token",
      expires_in: 7200,
      scope: "users:read scheduled_events:read scheduled_events:write",
    },
    mockUserInfo: () => {
      server.use(
        http.get("https://api.calendly.com/users/me", () => {
          return HttpResponse.json({
            resource: {
              uri: "https://api.calendly.com/users/calendly-test-user",
              name: "Calendly Test User",
              email: "calendly@example.test",
            },
          });
        }),
      );
    },
  },
  {
    connectorSlug: "canva",
    label: "Canva",
    clientEnvPrefix: "CANVA",
    authorizationEndpoint: "https://www.canva.com/api/oauth/authorize",
    tokenUrl: "https://api.canva.com/rest/v1/oauth/token",
    pkce: true,
    tokenResponse: {
      access_token: "canva-test-token",
      refresh_token: "canva-refresh-token",
      expires_in: 14_400,
    },
    mockUserInfo: () => {
      server.use(
        http.get("https://api.canva.com/rest/v1/users/me", () => {
          return HttpResponse.json({
            team_user: { user_id: "canva-user-123", team_id: "canva-team-123" },
          });
        }),
        http.get("https://api.canva.com/rest/v1/users/me/profile", () => {
          return HttpResponse.json({
            profile: { display_name: "Canva Test User" },
          });
        }),
      );
    },
  },
  {
    connectorSlug: "close",
    label: "Close",
    clientEnvPrefix: "CLOSE",
    authorizationEndpoint: "https://app.close.com/oauth2/authorize/",
    tokenUrl: "https://api.close.com/oauth2/token/",
    tokenResponse: {
      access_token: "close-test-token",
      refresh_token: "close-refresh-token",
      expires_in: 3600,
      organization_id: "close-org-123",
    },
    mockUserInfo: () => {
      server.use(
        http.get("https://api.close.com/api/v1/me/", () => {
          return HttpResponse.json({
            id: "close-user-123",
            email: "close@example.test",
          });
        }),
      );
    },
  },
  {
    connectorSlug: "copper",
    label: "Copper",
    clientEnvPrefix: "COPPER",
    authorizationEndpoint: "https://app.copper.com/oauth/authorize",
    tokenUrl: "https://app.copper.com/oauth/token",
    tokenResponse: { access_token: "copper-test-token" },
    mockUserInfo: () => {
      server.use(
        http.get("https://api.copper.com/developer_api/v1/account", () => {
          return HttpResponse.json({
            id: "copper-account-123",
            name: "Copper Test Account",
          });
        }),
      );
    },
  },
  {
    connectorSlug: "datadog",
    label: "Datadog",
    clientEnvPrefix: "DATADOG",
    authorizationEndpoint: "https://app.datadoghq.com/oauth2/v1/authorize",
    // Datadog resolves the token host from the domain it returns on the
    // callback, so the exchange never reaches a fixed provider host.
    tokenUrl: "https://api.datadoghq.com/oauth2/v1/token",
    pkce: true,
    callbackQuery: { domain: "datadoghq.com" },
    tokenResponse: {
      access_token: "datadog-test-token",
      refresh_token: "datadog-refresh-token",
      expires_in: 3600,
    },
  },
  {
    connectorSlug: "deel",
    label: "Deel",
    clientEnvPrefix: "DEEL",
    authorizationEndpoint: "https://app.deel.com/oauth2/authorize",
    tokenUrl: "https://app.deel.com/oauth2/tokens",
    pkce: true,
    tokenResponse: {
      access_token: "deel-test-token",
      refresh_token: "deel-refresh-token",
      expires_in: 2_592_000,
    },
    mockUserInfo: () => {
      server.use(
        http.get("https://api.letsdeel.com/rest/people/me", () => {
          return HttpResponse.json({
            id: "deel-user-123",
            full_name: "Deel Test User",
            email: "deel@example.test",
          });
        }),
      );
    },
  },
  {
    connectorSlug: "docusign",
    label: "DocuSign",
    clientEnvPrefix: "DOCUSIGN",
    authorizationEndpoint: "https://account-d.docusign.com/oauth/auth",
    tokenUrl: "https://account-d.docusign.com/oauth/token",
    pkce: true,
    tokenResponse: {
      access_token: "docusign-test-token",
      refresh_token: "docusign-refresh-token",
      expires_in: 28_800,
    },
    mockUserInfo: () => {
      server.use(
        http.get("https://account-d.docusign.com/oauth/userinfo", () => {
          return HttpResponse.json({
            sub: "docusign-user-123",
            name: "DocuSign Test User",
            email: "docusign@example.test",
          });
        }),
      );
    },
  },
  {
    connectorSlug: "dropbox",
    label: "Dropbox",
    clientEnvPrefix: "DROPBOX",
    authorizationEndpoint: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    tokenResponse: {
      access_token: "dropbox-test-token",
      refresh_token: "dropbox-refresh-token",
      expires_in: 14_400,
    },
    mockUserInfo: () => {
      server.use(
        http.post(
          "https://api.dropboxapi.com/2/users/get_current_account",
          () => {
            return HttpResponse.json({
              account_id: "dbid:dropbox-user-123",
              name: { display_name: "Dropbox Test User" },
              email: "dropbox@example.test",
            });
          },
        ),
      );
    },
  },
  {
    connectorSlug: "figma",
    label: "Figma",
    clientEnvPrefix: "FIGMA",
    authorizationEndpoint: "https://www.figma.com/oauth",
    tokenUrl: "https://api.figma.com/v1/oauth/token",
    tokenResponse: {
      access_token: "figma-test-token",
      refresh_token: "figma-refresh-token",
      expires_in: 7_776_000,
    },
    mockUserInfo: () => {
      server.use(
        http.get("https://api.figma.com/v1/me", () => {
          return HttpResponse.json({
            id: "figma-user-123",
            email: "figma@example.test",
            handle: "figma-test-user",
          });
        }),
      );
    },
  },
  {
    connectorSlug: "garmin-connect",
    label: "Garmin Connect",
    clientEnvPrefix: "GARMIN_CONNECT",
    authorizationEndpoint: "https://connect.garmin.com/oauth2Confirm",
    tokenUrl: "https://diauth.garmin.com/di-oauth2-service/oauth/token",
    pkce: true,
    // Garmin Connect authenticates the exchange with the PKCE verifier and
    // state instead of replaying the redirect URI.
    omitsTokenRedirectUri: true,
    tokenResponse: {
      access_token: "garmin-connect-test-token",
      refresh_token: "garmin-connect-refresh-token",
      expires_in: 86_400,
    },
    mockUserInfo: () => {
      server.use(
        http.get("https://apis.garmin.com/wellness-api/rest/user/id", () => {
          return HttpResponse.json({
            userId: "garmin-user-123",
            displayName: "Garmin Test User",
          });
        }),
      );
    },
  },
  {
    connectorSlug: "mailchimp",
    label: "Mailchimp",
    clientEnvPrefix: "MAILCHIMP",
    authorizationEndpoint: "https://login.mailchimp.com/oauth2/authorize",
    tokenUrl: "https://login.mailchimp.com/oauth2/token",
    tokenResponse: { access_token: "mailchimp-test-token" },
    mockUserInfo: () => {
      server.use(
        http.get("https://login.mailchimp.com/oauth2/metadata", () => {
          return HttpResponse.json({
            dc: "us1",
            user_id: 123,
            accountname: "Mailchimp Test Account",
            login: {
              login_name: "Mailchimp Test User",
              login_email: "mailchimp@example.test",
            },
            api_endpoint: "https://us1.api.mailchimp.com",
          });
        }),
      );
    },
  },
  {
    connectorSlug: "mercury",
    label: "Mercury",
    clientEnvPrefix: "MERCURY",
    authorizationEndpoint: "https://oauth2.mercury.com/oauth2/auth",
    tokenUrl: "https://oauth2.mercury.com/oauth2/token",
    pkce: true,
    tokenResponse: {
      access_token: "mercury-test-token",
      refresh_token: "mercury-refresh-token",
      expires_in: 3600,
    },
    mockUserInfo: () => {
      server.use(
        http.get("https://api.mercury.com/api/v1/organization", () => {
          return HttpResponse.json({
            organization: {
              id: "mercury-org-123",
              legalBusinessName: "Mercury Test Org",
            },
          });
        }),
      );
    },
  },
  {
    connectorSlug: "neon",
    label: "Neon",
    clientEnvPrefix: "NEON",
    authorizationEndpoint: "https://oauth2.neon.tech/oauth2/auth",
    tokenUrl: "https://oauth2.neon.tech/oauth2/token",
    tokenResponse: {
      access_token: "neon-test-token",
      refresh_token: "neon-refresh-token",
      expires_in: 3600,
    },
    mockUserInfo: () => {
      server.use(
        http.get("https://console.neon.tech/api/v2/users/me", () => {
          return HttpResponse.json({
            id: "neon-user-123",
            name: "Neon Test User",
            email: "neon@example.test",
          });
        }),
      );
    },
  },
  {
    connectorSlug: "posthog",
    label: "PostHog",
    publicClientId: "https://app.okou.ai/connectors/posthog/metadata.json",
    authorizationEndpoint: "https://oauth.posthog.com/oauth/authorize/",
    tokenUrl: "https://oauth.posthog.com/oauth/token/",
    pkce: true,
    tokenResponse: {
      access_token: "posthog-test-token",
      refresh_token: "posthog-refresh-token",
      expires_in: 3600,
      posthog_region: "eu",
      posthog_base_url: "https://eu.posthog.com",
    },
    mockUserInfo: () => {
      server.use(
        http.get("https://eu.posthog.com/api/users/@me/", () => {
          return HttpResponse.json({
            id: 123,
            first_name: "PostHog",
            last_name: "Test User",
            email: "posthog@example.test",
          });
        }),
      );
    },
  },
  {
    connectorSlug: "reddit",
    label: "Reddit",
    clientEnvPrefix: "REDDIT",
    authorizationEndpoint: "https://www.reddit.com/api/v1/authorize",
    tokenUrl: "https://www.reddit.com/api/v1/access_token",
    tokenResponse: {
      access_token: "reddit-test-token",
      refresh_token: "reddit-refresh-token",
      expires_in: 86_400,
    },
    mockUserInfo: () => {
      server.use(
        http.get("https://oauth.reddit.com/api/v1/me", () => {
          return HttpResponse.json({
            id: "reddit-user-123",
            name: "reddit-test-user",
          });
        }),
      );
    },
  },
  {
    connectorSlug: "spotify",
    label: "Spotify",
    clientEnvPrefix: "SPOTIFY",
    authorizationEndpoint: "https://accounts.spotify.com/authorize",
    tokenUrl: "https://accounts.spotify.com/api/token",
    tokenResponse: {
      access_token: "spotify-test-token",
      refresh_token: "spotify-refresh-token",
      expires_in: 3600,
    },
    mockUserInfo: () => {
      server.use(
        http.get("https://api.spotify.com/v1/me", () => {
          return HttpResponse.json({
            account_id: "spotify-user-123",
            display_name: "Spotify Test User",
            email: "spotify@example.test",
          });
        }),
      );
    },
  },
  {
    connectorSlug: "supabase",
    label: "Supabase",
    clientEnvPrefix: "SUPABASE",
    authorizationEndpoint: "https://api.supabase.com/v1/oauth/authorize",
    tokenUrl: "https://api.supabase.com/v1/oauth/token",
    pkce: true,
    tokenResponse: {
      access_token: "supabase-test-token",
      refresh_token: "supabase-refresh-token",
      expires_in: 3600,
    },
    mockUserInfo: () => {
      server.use(
        http.get("https://api.supabase.com/v1/profile", () => {
          return HttpResponse.json({
            gotrue_id: "supabase-user-123",
            primary_email: "supabase@example.test",
            username: "supabase-test-user",
          });
        }),
      );
    },
  },
  {
    connectorSlug: "webflow",
    label: "Webflow",
    clientEnvPrefix: "WEBFLOW",
    authorizationEndpoint: "https://webflow.com/oauth/authorize",
    tokenUrl: "https://api.webflow.com/oauth/access_token",
    jsonTokenRequest: true,
    tokenResponse: {
      access_token: "webflow-test-token",
      token_type: "bearer",
    },
    mockUserInfo: () => {
      server.use(
        http.get("https://api.webflow.com/v2/token/authorized_by", () => {
          return HttpResponse.json({
            id: "webflow-user-123",
            email: "webflow@example.test",
            firstName: "Webflow",
            lastName: "Test User",
          });
        }),
      );
    },
  },
  {
    connectorSlug: "zoom",
    label: "Zoom",
    clientEnvPrefix: "ZOOM",
    authorizationEndpoint: "https://zoom.us/oauth/authorize",
    tokenUrl: "https://zoom.us/oauth/token",
    tokenResponse: {
      access_token: "zoom-test-token",
      refresh_token: "zoom-refresh-token",
      expires_in: 3600,
    },
    mockUserInfo: () => {
      server.use(
        http.get("https://api.zoom.us/v2/users/me", () => {
          return HttpResponse.json({
            id: "zoom-user-123",
            email: "zoom@example.test",
            display_name: "Zoom Test User",
          });
        }),
      );
    },
  },
];

const LAUNCH_GATED_DIRECT_OKOU_CONNECTOR_SLUGS =
  LAUNCH_GATED_DIRECT_OKOU_CASES.map((providerCase) => {
    return providerCase.connectorSlug;
  });

const jsonTokenRequestSchema = z.record(z.string(), z.string());

function launchGatedTokenRequestParams(
  providerCase: LaunchGatedDirectOkouCase,
  body: string,
): URLSearchParams {
  if (providerCase.jsonTokenRequest !== true) {
    return new URLSearchParams(body);
  }
  const parsed: unknown = JSON.parse(body);
  return new URLSearchParams(
    Object.entries(jsonTokenRequestSchema.parse(parsed)),
  );
}

function launchGatedClientId(providerCase: LaunchGatedDirectOkouCase): string {
  return "publicClientId" in providerCase
    ? providerCase.publicClientId
    : `${providerCase.connectorSlug}-test-client-id`;
}

function mockLaunchGatedOAuthEnv(): void {
  for (const providerCase of LAUNCH_GATED_DIRECT_OKOU_CASES) {
    if (!("clientEnvPrefix" in providerCase)) {
      continue;
    }
    mockOptionalEnv(
      `${providerCase.clientEnvPrefix}_OAUTH_CLIENT_ID`,
      launchGatedClientId(providerCase),
    );
    mockOptionalEnv(
      `${providerCase.clientEnvPrefix}_OAUTH_CLIENT_SECRET`,
      `${providerCase.connectorSlug}-test-client-secret`,
    );
  }
}

function mockOAuthEnv(): void {
  mockLaunchGatedOAuthEnv();
  mockOptionalEnv("ASANA_OAUTH_CLIENT_ID", "asana-test-client-id");
  mockOptionalEnv("ASANA_OAUTH_CLIENT_SECRET", "asana-test-client-secret");
  mockOptionalEnv("BOX_OAUTH_CLIENT_ID", "box-test-client-id");
  mockOptionalEnv("BOX_OAUTH_CLIENT_SECRET", "box-test-client-secret");
  mockOptionalEnv("GH_OAUTH_CLIENT_ID", "test-client-id");
  mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "test-client-secret");
  mockOptionalEnv("AIRTABLE_OAUTH_CLIENT_ID", "airtable-test-client-id");
  mockOptionalEnv(
    "AIRTABLE_OAUTH_CLIENT_SECRET",
    "airtable-test-client-secret",
  );
  mockOptionalEnv("CLOUDFLARE_OAUTH_CLIENT_ID", "cloudflare-test-client-id");
  mockOptionalEnv(
    "CLOUDFLARE_OAUTH_CLIENT_SECRET",
    "cloudflare-test-client-secret",
  );
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-test-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-test-client-secret");
  mockOptionalEnv("GUMROAD_OAUTH_CLIENT_ID", "gumroad-test-client-id");
  mockOptionalEnv("GUMROAD_OAUTH_CLIENT_SECRET", "gumroad-test-client-secret");
  mockOptionalEnv("HUBSPOT_OAUTH_CLIENT_ID", "hubspot-test-client-id");
  mockOptionalEnv("HUBSPOT_OAUTH_CLIENT_SECRET", "hubspot-test-client-secret");
  mockOptionalEnv(
    "INTERVALS_ICU_OAUTH_CLIENT_ID",
    "intervals-icu-test-client-id",
  );
  mockOptionalEnv(
    "INTERVALS_ICU_OAUTH_CLIENT_SECRET",
    "intervals-icu-test-client-secret",
  );
  mockOptionalEnv("LINEAR_OAUTH_CLIENT_ID", "linear-test-client-id");
  mockOptionalEnv("LINEAR_OAUTH_CLIENT_SECRET", "linear-test-client-secret");
  mockOptionalEnv("META_ADS_OAUTH_CLIENT_ID", "meta-ads-test-client-id");
  mockOptionalEnv(
    "META_ADS_OAUTH_CLIENT_SECRET",
    "meta-ads-test-client-secret",
  );
  mockOptionalEnv("MONDAY_OAUTH_CLIENT_ID", "monday-test-client-id");
  mockOptionalEnv("MONDAY_OAUTH_CLIENT_SECRET", "monday-test-client-secret");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-test-client-id");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-test-client-secret");
  mockOptionalEnv("QUICKBOOKS_OAUTH_CLIENT_ID", "quickbooks-test-client-id");
  mockOptionalEnv(
    "QUICKBOOKS_OAUTH_CLIENT_SECRET",
    "quickbooks-test-client-secret",
  );
  mockOptionalEnv("SENTRY_OAUTH_CLIENT_ID", "sentry-test-client-id");
  mockOptionalEnv("SENTRY_OAUTH_CLIENT_SECRET", "sentry-test-client-secret");
  mockOptionalEnv("SLACK_OAUTH_CLIENT_ID", "test-slack-client-id");
  mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "test-slack-client-secret");
  mockOptionalEnv("STRAVA_OAUTH_CLIENT_ID", "strava-test-client-id");
  mockOptionalEnv("STRAVA_OAUTH_CLIENT_SECRET", "strava-test-client-secret");
  mockOptionalEnv("STRIPE_OAUTH_CLIENT_ID", "stripe-test-client-id");
  mockOptionalEnv("STRIPE_OAUTH_CLIENT_SECRET", "stripe-test-client-secret");
  mockOptionalEnv("TIKTOK_ADS_OAUTH_CLIENT_ID", "tiktok-ads-test-client-id");
  mockOptionalEnv(
    "TIKTOK_ADS_OAUTH_CLIENT_SECRET",
    "tiktok-ads-test-client-secret",
  );
  mockOptionalEnv("TODOIST_OAUTH_CLIENT_ID", "todoist-test-client-id");
  mockOptionalEnv("TODOIST_OAUTH_CLIENT_SECRET", "todoist-test-client-secret");
  mockOptionalEnv("VERCEL_OAUTH_CLIENT_ID", "vercel-test-client-id");
  mockOptionalEnv("VERCEL_OAUTH_CLIENT_SECRET", "vercel-test-client-secret");
  mockOptionalEnv("X_OAUTH_CLIENT_ID", "x-test-client-id");
  mockOptionalEnv("X_OAUTH_CLIENT_SECRET", "x-test-client-secret");
  mockOptionalEnv("XERO_OAUTH_CLIENT_ID", "xero-test-client-id");
  mockOptionalEnv("XERO_OAUTH_CLIENT_SECRET", "xero-test-client-secret");
}

function expectCloudflareAuthorizationScopes(authorizationUrl: URL): void {
  const method = API_TEST_CONNECTOR_CATALOG.connectors
    .find((connector) => {
      return connector.slug === "cloudflare";
    })
    ?.authMethods.find((authMethod) => {
      return authMethod.id === "oauth";
    });
  if (method?.grant.kind !== "auth-code") {
    throw new Error("Expected Cloudflare OAuth auth-code fixture");
  }
  expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toStrictEqual(
    method.grant.scopes,
  );
  expect(method.grant.scopes).toContain("offline_access");
}

async function requestOauthStart(
  connectorSlug: string,
  options: {
    readonly authMethod?: ConnectorAuthMethodId;
    readonly authenticated?: boolean;
    readonly callbackTarget?: "app";
    readonly headers?: RequestInit["headers"];
    readonly origin?: string;
  } = {},
): Promise<Response> {
  if (options.authenticated) {
    mockAuthenticatedSession();
  }
  const headers = new Headers(options.headers);
  if (options.authenticated) {
    headers.set("authorization", "Bearer clerk-session");
  }
  headers.set("content-type", "application/json");
  const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
  return await app.request(oauthStartUrl(connectorSlug, options.origin), {
    method: "POST",
    headers,
    body: JSON.stringify({
      authMethod: options.authMethod ?? "oauth",
      account: { intent: "add" },
      ...(options.callbackTarget
        ? { callbackTarget: options.callbackTarget }
        : {}),
    }),
  });
}

async function authorizationUrlFromResponse(response: Response): Promise<URL> {
  const body = connectorOauthStartResponseSchema.parse(await response.json());
  return new URL(body.authorizationUrl);
}

function expectOauthState(authorizationUrl: URL): string {
  const state = authorizationUrl.searchParams.get("state");
  expect(state).toMatch(/^[0-9a-f]{64}$/);
  return state!;
}

interface DirectOkouTokenExchangeCase {
  readonly connectorSlug: string;
  readonly label: string;
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly tokenUrl: string;
  readonly tokenResponse: JsonBodyType;
  readonly callbackQuery?: Readonly<Record<string, string>>;
  readonly mockUserInfo?: () => void;
}

// Providers whose token exchange replays the exact redirect URI persisted at
// OAuth start. Airtable and X are covered separately because they also assert
// PKCE behavior.
const DIRECT_OKOU_TOKEN_EXCHANGE_CASES: readonly DirectOkouTokenExchangeCase[] =
  [
    {
      connectorSlug: "asana",
      label: "Asana",
      authorizationEndpoint: "https://app.asana.com/-/oauth_authorize",
      clientId: "asana-test-client-id",
      tokenUrl: ASANA_OAUTH_TOKEN_URL,
      tokenResponse: {
        access_token: "asana-test-token",
        refresh_token: "asana-refresh-token",
        expires_in: 3600,
        data: {
          gid: "asana-user-123",
          name: "Asana Test User",
          email: "asana@example.test",
        },
      },
    },
    {
      connectorSlug: "gumroad",
      label: "Gumroad",
      authorizationEndpoint: "https://gumroad.com/oauth/authorize",
      clientId: "gumroad-test-client-id",
      tokenUrl: GUMROAD_OAUTH_TOKEN_URL,
      tokenResponse: {
        access_token: "gumroad-test-token",
        refresh_token: "gumroad-refresh-token",
        scope: "view_profile view_sales",
      },
      mockUserInfo: () => {
        server.use(
          http.get(GUMROAD_USER_URL, () => {
            return HttpResponse.json({
              user: {
                id: "gumroad-user-123",
                name: "Gumroad Test User",
                email: "gumroad@example.test",
              },
            });
          }),
        );
      },
    },
    {
      connectorSlug: "linear",
      label: "Linear",
      authorizationEndpoint: "https://linear.app/oauth/authorize",
      clientId: "linear-test-client-id",
      tokenUrl: LINEAR_OAUTH_TOKEN_URL,
      tokenResponse: {
        access_token: "linear-test-token",
        refresh_token: "linear-refresh-token",
        expires_in: 86_399,
        scope: "read,write",
      },
      mockUserInfo: () => {
        server.use(
          http.post(LINEAR_GRAPHQL_URL, () => {
            return HttpResponse.json({
              data: {
                viewer: {
                  id: "linear-user-123",
                  name: "Linear Test User",
                  email: "linear@example.test",
                },
              },
            });
          }),
        );
      },
    },
    {
      connectorSlug: "monday",
      label: "Monday.com",
      authorizationEndpoint: "https://auth.monday.com/oauth2/authorize",
      clientId: "monday-test-client-id",
      tokenUrl: MONDAY_OAUTH_TOKEN_URL,
      tokenResponse: {
        access_token: "monday-test-token",
        refresh_token: "monday-refresh-token",
        scope: "me:read boards:read boards:write",
      },
      mockUserInfo: () => {
        server.use(
          http.post(MONDAY_GRAPHQL_URL, () => {
            return HttpResponse.json({
              data: {
                me: {
                  id: "monday-user-123",
                  name: "Monday Test User",
                  email: "monday@example.test",
                },
              },
            });
          }),
        );
      },
    },
    {
      connectorSlug: "quickbooks",
      label: "QuickBooks",
      authorizationEndpoint: "https://appcenter.intuit.com/connect/oauth2",
      clientId: "quickbooks-test-client-id",
      tokenUrl: QUICKBOOKS_OAUTH_TOKEN_URL,
      tokenResponse: {
        access_token: "quickbooks-test-token",
        refresh_token: "quickbooks-refresh-token",
        expires_in: 3600,
        scope: "com.intuit.quickbooks.accounting openid profile email",
      },
      callbackQuery: { realmId: "quickbooks-realm-123" },
      mockUserInfo: () => {
        server.use(
          http.get(QUICKBOOKS_USERINFO_URL, () => {
            return HttpResponse.json({
              sub: "quickbooks-user-123",
              givenName: "QuickBooks",
              familyName: "Test User",
              email: "quickbooks@example.test",
            });
          }),
        );
      },
    },
    {
      connectorSlug: "sentry",
      label: "Sentry",
      authorizationEndpoint: "https://sentry.io/oauth/authorize/",
      clientId: "sentry-test-client-id",
      tokenUrl: SENTRY_OAUTH_TOKEN_URL,
      tokenResponse: {
        access_token: "sentry-test-token",
        refresh_token: "sentry-refresh-token",
        expires_in: 2_592_000,
        scope: "org:read project:read event:read",
        user: {
          id: "sentry-user-123",
          name: "Sentry Test User",
          email: "sentry@example.test",
        },
      },
    },
    {
      connectorSlug: "todoist",
      label: "Todoist",
      authorizationEndpoint: "https://todoist.com/oauth/authorize",
      clientId: "todoist-test-client-id",
      tokenUrl: TODOIST_OAUTH_TOKEN_URL,
      tokenResponse: {
        access_token: "todoist-test-token",
        token_type: "Bearer",
      },
      mockUserInfo: () => {
        server.use(
          http.get(TODOIST_USER_URL, () => {
            return HttpResponse.json({
              id: "todoist-user-123",
              full_name: "Todoist Test User",
              email: "todoist@example.test",
            });
          }),
        );
      },
    },
    {
      connectorSlug: "xero",
      label: "Xero",
      authorizationEndpoint:
        "https://login.xero.com/identity/connect/authorize",
      clientId: "xero-test-client-id",
      tokenUrl: XERO_OAUTH_TOKEN_URL,
      tokenResponse: {
        access_token: "xero-test-token",
        refresh_token: "xero-refresh-token",
        expires_in: 1800,
        scope: "openid profile email accounting.transactions offline_access",
      },
      mockUserInfo: () => {
        server.use(
          http.get(XERO_USERINFO_URL, () => {
            return HttpResponse.json({
              sub: "xero-user-123",
              name: "Xero Test User",
              email: "xero@example.test",
            });
          }),
        );
      },
    },
  ];

// Every newly ready connector whose authorization URL carries the redirect URI.
// Vercel is excluded because its Integration URL controls routing instead.
const REDIRECTING_DIRECT_OKOU_CONNECTOR_SLUGS = [
  "airtable",
  "asana",
  "gumroad",
  "intervals-icu",
  "linear",
  "monday",
  "quickbooks",
  "sentry",
  "strava",
  "stripe",
  "todoist",
  "x",
  "xero",
] as const;

async function completeAppOauthCallback(
  connectorSlug: string,
  state: string,
  callbackQuery: Readonly<Record<string, string>> = {},
): Promise<URL> {
  const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
  const callback = await app.request(
    `${API_ORIGIN}/api/connectors/${connectorSlug}/callback?${new URLSearchParams(
      {
        code: `${connectorSlug}-authorization-code`,
        state,
        ...callbackQuery,
      },
    )}`,
    { headers: { "x-okou-web-origin": "https://okou.ai" } },
  );

  expect(callback.status).toBe(307);
  return new URL(callback.headers.get("location") ?? "");
}

async function completeLaunchGatedOauthCallback(
  providerCase: LaunchGatedDirectOkouCase,
  state: string,
): Promise<URL> {
  return await completeAppOauthCallback(
    providerCase.connectorSlug,
    state,
    providerCase.callbackQuery ?? {},
  );
}

async function rejectProviderAuthorization(
  authorizationUrl: URL,
): Promise<void> {
  const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
  const state = authorizationUrl.searchParams.get("state");
  expect(redirectUri).toBeTruthy();
  expect(state).toBeTruthy();

  const callbackUrl = new URL(redirectUri!);
  callbackUrl.searchParams.set("error", "access_denied");
  callbackUrl.searchParams.set("state", state!);

  const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
  await app.request(callbackUrl.toString());
}

describe("POST /api/connectors/:connectorSlug/oauth/start", () => {
  beforeEach(() => {
    mockEnv("OKOU_API_BACKEND_URL", API_ORIGIN);
    mockEnv("OKOU_WEB_URL", WEB_ORIGIN);
    mockOAuthEnv();
  });

  afterEach(() => {
    clearMockNow();
  });

  it("allows auth-code OAuth start when the connector feature is disabled", async () => {
    const response = await requestOauthStart("test-oauth", {
      authenticated: true,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expectOauthState(authorizationUrl);
  });

  it("returns the future connection id for an unnamed account addition", async () => {
    const response = await requestOauthStart("test-oauth", {
      authenticated: true,
    });

    expect(response.status).toBe(200);
    const body = connectorOauthStartResponseSchema.parse(await response.json());
    expect(body.connectionId).toBeTruthy();
    const authorizationUrl = new URL(body.authorizationUrl);
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("keeps an omitted callback target on the existing Web callback", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("youtube", {
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "google-test-client-id",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}/api/connectors/youtube/callback`,
    );
    expect(
      authorizationUrl.searchParams.get("scope")?.split(" "),
    ).toStrictEqual([...YOUTUBE_OAUTH_SCOPES]);
    expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
    expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("returns the provider authorization URL without an API redirect", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("github", {
      headers: authHeaders(),
      origin: WEB_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "test-client-id",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}/api/connectors/github/callback`,
    );
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("uses the configured web origin for local OAuth callback URLs", async () => {
    mockEnv("OKOU_WEB_URL", LOCAL_WEB_ORIGIN);
    mockAuthenticatedSession();

    const response = await requestOauthStart("github", {
      headers: authHeaders(),
      origin: LOCAL_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${LOCAL_WEB_ORIGIN}/api/connectors/github/callback`,
    );
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("uses the direct Okou App callback for a ready Google connector", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("google-maps", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/connectors/google-maps/callback",
    );
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it.each(["google-maps", "test-oauth"])(
    "returns %s App callback errors to the configured Okou app",
    async (connectorSlug) => {
      mockEnv("APP_URL", "https://app.okou.ai");
      mockAuthenticatedSession();
      const response = await requestOauthStart(connectorSlug, {
        callbackTarget: "app",
        headers: authHeaders(),
        origin: API_ORIGIN,
      });
      expect(response.status).toBe(200);
      const authorizationUrl = await authorizationUrlFromResponse(response);
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        `https://app.okou.ai/connectors/${connectorSlug}/callback`,
      );
      const state = expectOauthState(authorizationUrl);

      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const callback = await app.request(
        `${API_ORIGIN}/api/connectors/${connectorSlug}/callback?${new URLSearchParams(
          {
            error: "access_denied",
            state,
          },
        )}`,
        { headers: { "x-okou-web-origin": "https://okou.ai" } },
      );
      expect(callback.status).toBe(307);
      const location = new URL(callback.headers.get("location") ?? "");
      expect(location.origin).toBe("https://app.okou.ai");
      expect(location.pathname).toBe("/connector/error");
    },
  );

  it("uses the direct Okou App callback for GitHub and reuses its exact redirect URI", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(GITHUB_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "github-test-token",
          scope: GITHUB_OAUTH_SCOPES.join(","),
        });
      }),
      http.get(GITHUB_USER_URL, () => {
        return HttpResponse.json({
          id: 4242,
          login: "github-test-user",
          email: "github@example.test",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("github", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "test-client-id",
    );
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBe("https://app.okou.ai/connectors/github/callback");
    expect(
      authorizationUrl.searchParams.get("scope")?.split(" "),
    ).toStrictEqual([...GITHUB_OAUTH_SCOPES]);
    const state = expectOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${API_ORIGIN}/api/connectors/github/callback?${new URLSearchParams({
        code: "github-authorization-code",
        state,
      })}`,
      { headers: { "x-okou-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.origin).toBe("https://app.okou.ai");
    expect(callbackLocation.pathname).toBe("/connector/success");
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);
  });

  it.each(["github", "quickbooks", "stripe"])(
    "returns %s provider denial to the configured Okou app",
    async (connectorSlug) => {
      mockEnv("APP_URL", "https://app.okou.ai");
      mockAuthenticatedSession();
      const response = await requestOauthStart(connectorSlug, {
        callbackTarget: "app",
        headers: authHeaders(),
        origin: API_ORIGIN,
      });
      expect(response.status).toBe(200);
      const authorizationUrl = await authorizationUrlFromResponse(response);
      const state = expectOauthState(authorizationUrl);

      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const callback = await app.request(
        `${API_ORIGIN}/api/connectors/${connectorSlug}/callback?${new URLSearchParams(
          {
            error: "access_denied",
            state,
          },
        )}`,
        { headers: { "x-okou-web-origin": "https://okou.ai" } },
      );
      expect(callback.status).toBe(307);
      const location = new URL(callback.headers.get("location") ?? "");
      expect(location.origin).toBe("https://app.okou.ai");
      expect(location.pathname).toBe("/connector/error");
    },
  );

  it("uses the direct Okou App callback for Airtable and reuses its exact PKCE redirect URI", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(AIRTABLE_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "airtable-test-token",
          refresh_token: "airtable-refresh-token",
          expires_in: 3600,
          scope: "data.records:read",
        });
      }),
      http.get(AIRTABLE_WHOAMI_URL, () => {
        return HttpResponse.json({
          id: "airtable-user-123",
          email: "airtable@example.test",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("airtable", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const startBody = connectorOauthStartResponseSchema.parse(
      await response.json(),
    );
    const authorizationUrl = new URL(startBody.authorizationUrl);
    expect(startBody.connectionId).toBeTruthy();
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://airtable.com/oauth2/v1/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "airtable-test-client-id",
    );
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBe(
      "https://app.okou.ai/connectors/airtable/callback",
    );
    expect(authorizationUrl.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    const state = expectOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${API_ORIGIN}/api/connectors/airtable/callback?${new URLSearchParams({
        code: "airtable-authorization-code",
        state,
      })}`,
      { headers: { "x-okou-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    expect(new URL(callback.headers.get("location") ?? "").origin).toBe(
      "https://app.okou.ai",
    );
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);
    expect(tokenBodies[0]?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]+$/u);
    const connected = await app.request(
      `${API_ORIGIN}/api/connectors/airtable`,
      { headers: authHeaders() },
    );
    expect(connected.status).toBe(200);
    await expect(connected.json()).resolves.toMatchObject({
      id: startBody.connectionId,
    });
  });

  it("reuses the direct Okou redirect URI for a Google token exchange", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(GOOGLE_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "gmail-test-token",
          refresh_token: "gmail-refresh-token",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.modify",
        });
      }),
      http.get(GOOGLE_OPENID_USERINFO_URL, () => {
        return HttpResponse.json({
          sub: "gmail-user-123",
          email: "gmail@example.test",
          name: "Gmail Test User",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("gmail", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBe("https://app.okou.ai/connectors/gmail/callback");
    const state = expectOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${API_ORIGIN}/api/connectors/gmail/callback?${new URLSearchParams({
        code: "gmail-authorization-code",
        state,
      })}`,
      { headers: { "x-okou-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.origin).toBe("https://app.okou.ai");
    expect(callbackLocation.pathname).toBe("/connector/success");
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);
  });

  it("uses the direct Okou App callback for Box and reuses its exact redirect URI", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(BOX_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "box-test-token",
          refresh_token: "box-refresh-token",
          expires_in: 3600,
          scope: "root_readwrite",
        });
      }),
      http.get(BOX_CURRENT_USER_URL, () => {
        return HttpResponse.json({
          id: "box-user-123",
          name: "Box Test User",
          login: "box@example.test",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("box", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://account.box.com/api/oauth2/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "box-test-client-id",
    );
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBe("https://app.okou.ai/connectors/box/callback");
    const state = expectOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${API_ORIGIN}/api/connectors/box/callback?${new URLSearchParams({
        code: "box-authorization-code",
        state,
      })}`,
      { headers: { "x-okou-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.origin).toBe("https://app.okou.ai");
    expect(callbackLocation.pathname).toBe("/connector/success");
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);
  });

  it("uses the direct Okou App callback for HubSpot and reuses its exact redirect URI", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(HUBSPOT_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "hubspot-test-token",
          refresh_token: "hubspot-refresh-token",
          expires_in: 1800,
        });
      }),
      http.get(`${HUBSPOT_TOKEN_INFO_URL}/hubspot-test-token`, () => {
        return HttpResponse.json({
          user_id: 123,
          user: "hubspot@example.test",
          hub_domain: "example.test",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("hubspot", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://app.hubspot.com/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "hubspot-test-client-id",
    );
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBe("https://app.okou.ai/connectors/hubspot/callback");
    const state = expectOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${API_ORIGIN}/api/connectors/hubspot/callback?${new URLSearchParams({
        code: "hubspot-authorization-code",
        state,
      })}`,
      { headers: { "x-okou-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.origin).toBe("https://app.okou.ai");
    expect(callbackLocation.pathname).toBe("/connector/success");
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);
  });

  it("uses the direct Okou App callback for Meta Ads and reuses its exact redirect URI", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(META_ADS_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "meta-ads-short-lived-token",
          token_type: "bearer",
          expires_in: 3600,
        });
      }),
      http.get(META_ADS_OAUTH_TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "meta-ads-long-lived-token",
          token_type: "bearer",
          expires_in: 5_184_000,
        });
      }),
      http.get(META_ADS_USER_URL, () => {
        return HttpResponse.json({
          id: "meta-ads-user-123",
          name: "Meta Ads Test User",
          email: "meta-ads@example.test",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("meta-ads", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://www.facebook.com/v22.0/dialog/oauth",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "meta-ads-test-client-id",
    );
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBe(
      "https://app.okou.ai/connectors/meta-ads/callback",
    );
    const state = expectOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${API_ORIGIN}/api/connectors/meta-ads/callback?${new URLSearchParams({
        code: "meta-ads-authorization-code",
        state,
      })}`,
      { headers: { "x-okou-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.origin).toBe("https://app.okou.ai");
    expect(callbackLocation.pathname).toBe("/connector/success");
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);
  });

  it("uses the direct Okou App callback for TikTok Ads without adding a token redirect URI", async () => {
    const tokenBodies: unknown[] = [];
    server.use(
      http.post(TIKTOK_ADS_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(await request.json());
        return HttpResponse.json({
          data: {
            access_token: "tiktok-ads-test-token",
            advertiser_ids: ["1234567890"],
          },
          request_id: "tiktok-ads-request-id",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("tiktok-ads", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://business-api.tiktok.com/portal/auth",
    );
    expect(authorizationUrl.searchParams.get("app_id")).toBe(
      "tiktok-ads-test-client-id",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/connectors/tiktok-ads/callback",
    );
    const state = expectOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${API_ORIGIN}/api/connectors/tiktok-ads/callback?${new URLSearchParams({
        auth_code: "tiktok-ads-authorization-code",
        state,
      })}`,
      { headers: { "x-okou-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.origin).toBe("https://app.okou.ai");
    expect(callbackLocation.pathname).toBe("/connector/success");
    expect(tokenBodies).toStrictEqual([
      {
        app_id: "tiktok-ads-test-client-id",
        secret: "tiktok-ads-test-client-secret",
        auth_code: "tiktok-ads-authorization-code",
      },
    ]);
  });

  it.each(["box", "hubspot", "meta-ads", "tiktok-ads"] as const)(
    "returns %s provider errors to the configured App callback",
    async (connectorSlug) => {
      mockEnv("APP_URL", "https://app.okou.ai");
      mockAuthenticatedSession();

      const response = await requestOauthStart(connectorSlug, {
        callbackTarget: "app",
        headers: authHeaders(),
        origin: API_ORIGIN,
      });

      expect(response.status).toBe(200);
      const authorizationUrl = await authorizationUrlFromResponse(response);
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        `https://app.okou.ai/connectors/${connectorSlug}/callback`,
      );
      expectOauthState(authorizationUrl);
      await rejectProviderAuthorization(authorizationUrl);
    },
  );

  it.each(["box", "hubspot", "meta-ads", "tiktok-ads"] as const)(
    "keeps an omitted %s callback target on the existing Web callback",
    async (connectorSlug) => {
      mockAuthenticatedSession();

      const response = await requestOauthStart(connectorSlug, {
        headers: authHeaders(),
        origin: API_ORIGIN,
      });

      expect(response.status).toBe(200);
      const authorizationUrl = await authorizationUrlFromResponse(response);
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        `${WEB_ORIGIN}/api/connectors/${connectorSlug}/callback`,
      );
      expectOauthState(authorizationUrl);
      await rejectProviderAuthorization(authorizationUrl);
    },
  );

  it.each(DIRECT_OKOU_TOKEN_EXCHANGE_CASES)(
    "uses the direct Okou App callback for $label and reuses its exact redirect URI",
    async (providerCase) => {
      const tokenBodies: URLSearchParams[] = [];
      server.use(
        http.post(providerCase.tokenUrl, async ({ request }) => {
          tokenBodies.push(new URLSearchParams(await request.text()));
          return HttpResponse.json(providerCase.tokenResponse);
        }),
      );
      providerCase.mockUserInfo?.();
      mockEnv("APP_URL", "https://app.okou.ai");
      mockAuthenticatedSession();

      const response = await requestOauthStart(providerCase.connectorSlug, {
        callbackTarget: "app",
        headers: authHeaders(),
        origin: API_ORIGIN,
      });

      expect(response.status).toBe(200);
      const authorizationUrl = await authorizationUrlFromResponse(response);
      expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
        providerCase.authorizationEndpoint,
      );
      expect(authorizationUrl.searchParams.get("client_id")).toBe(
        providerCase.clientId,
      );
      const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
      expect(redirectUri).toBe(
        `https://app.okou.ai/connectors/${providerCase.connectorSlug}/callback`,
      );
      const state = expectOauthState(authorizationUrl);

      const location = await completeAppOauthCallback(
        providerCase.connectorSlug,
        state,
        providerCase.callbackQuery,
      );

      expect(location.origin).toBe("https://app.okou.ai");
      expect(location.pathname).toBe("/connector/success");
      expect(tokenBodies).toHaveLength(1);
      expect(tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);
    },
  );

  it("uses the direct Okou App callback for Stripe Marketplace OAuth", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(STRIPE_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "stripe-test-token",
          refresh_token: "stripe-refresh-token",
          expires_in: 3600,
          livemode: true,
          stripe_user_id: "acct_stripe_test",
        });
      }),
      http.get(STRIPE_ACCOUNT_URL, () => {
        return HttpResponse.json({
          id: "acct_stripe_test",
          business_profile: { name: "Stripe Test Account" },
          email: "stripe@example.test",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("stripe", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://marketplace.stripe.com/oauth/v2/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "stripe-test-client-id",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/connectors/stripe/callback",
    );
    const state = expectOauthState(authorizationUrl);

    const location = await completeAppOauthCallback("stripe", state);

    expect(location.origin).toBe("https://app.okou.ai");
    expect(location.pathname).toBe("/connector/success");
    expect(tokenBodies).toHaveLength(1);
    expect(Object.fromEntries(tokenBodies[0]!)).toStrictEqual({
      code: "stripe-authorization-code",
      grant_type: "authorization_code",
    });
  });

  it("uses the direct Okou App callback for X and reuses its exact PKCE redirect URI", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(X_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "x-test-token",
          refresh_token: "x-refresh-token",
          expires_in: 7200,
          scope: "tweet.read tweet.write users.read offline.access",
        });
      }),
      http.get(X_USERS_ME_URL, () => {
        return HttpResponse.json({
          data: {
            id: "x-user-123",
            username: "x-test-user",
            name: "X Test User",
          },
        });
      }),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("x", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://x.com/i/oauth2/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "x-test-client-id",
    );
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBe("https://app.okou.ai/connectors/x/callback");
    expect(authorizationUrl.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]+$/u,
    );
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    const state = expectOauthState(authorizationUrl);

    const location = await completeAppOauthCallback("x", state);

    expect(location.origin).toBe("https://app.okou.ai");
    expect(location.pathname).toBe("/connector/success");
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);
    expect(tokenBodies[0]?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("uses the direct Okou App callback for Intervals.icu without adding a token redirect URI", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(INTERVALS_ICU_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "intervals-icu-test-token",
          athlete: { id: "i123456", name: "Intervals Test Athlete" },
        });
      }),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("intervals-icu", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://intervals.icu/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "intervals-icu-test-client-id",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/connectors/intervals-icu/callback",
    );
    const state = expectOauthState(authorizationUrl);

    const location = await completeAppOauthCallback("intervals-icu", state);

    expect(location.origin).toBe("https://app.okou.ai");
    expect(location.pathname).toBe("/connector/success");
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("redirect_uri")).toBeNull();
    expect(tokenBodies[0]?.get("code")).toBe(
      "intervals-icu-authorization-code",
    );
  });

  it("uses the direct Okou App callback for Strava without adding a token redirect URI", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(STRAVA_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "strava-test-token",
          refresh_token: "strava-refresh-token",
          expires_in: 21_600,
          scope: "read,activity:read_all",
          athlete: { id: 987_654, firstname: "Strava", lastname: "Athlete" },
        });
      }),
      http.get(STRAVA_ATHLETE_URL, () => {
        return HttpResponse.json({
          id: 987_654,
          firstname: "Strava",
          lastname: "Athlete",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("strava", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://www.strava.com/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "strava-test-client-id",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/connectors/strava/callback",
    );
    const state = expectOauthState(authorizationUrl);

    const location = await completeAppOauthCallback("strava", state);

    expect(location.origin).toBe("https://app.okou.ai");
    expect(location.pathname).toBe("/connector/success");
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("redirect_uri")).toBeNull();
    expect(tokenBodies[0]?.get("code")).toBe("strava-authorization-code");
  });

  // Vercel routes authorization through its Integration URL, so the
  // authorization URL carries no redirect URI. Callback selection is only
  // observable through the persisted URI replayed at token exchange.
  it.each([
    {
      target: "the direct Okou App callback",
      origin: API_ORIGIN,
      callbackTarget: "app" as const,
      expectedRedirectUri: "https://app.okou.ai/connectors/vercel/callback",
      expectedLocationOrigin: "https://app.okou.ai",
    },
    {
      target: "the existing Web callback",
      origin: API_ORIGIN,
      callbackTarget: undefined,
      expectedRedirectUri: `${WEB_ORIGIN}/api/connectors/vercel/callback`,
      expectedLocationOrigin: "https://app.okou.ai",
    },
  ])(
    "propagates $target through the Vercel token exchange",
    async (routingCase) => {
      const tokenBodies: URLSearchParams[] = [];
      server.use(
        http.post(VERCEL_OAUTH_TOKEN_URL, async ({ request }) => {
          tokenBodies.push(new URLSearchParams(await request.text()));
          return HttpResponse.json({
            access_token: "vercel-test-token",
            token_type: "Bearer",
            team_id: "team_test",
            installation_id: "icfg_test",
          });
        }),
        http.get(VERCEL_USER_URL, () => {
          return HttpResponse.json({
            user: {
              id: "vercel-user-123",
              username: "vercel-test-user",
              email: "vercel@example.test",
            },
          });
        }),
      );
      mockEnv("APP_URL", "https://app.okou.ai");
      mockAuthenticatedSession();

      const response = await requestOauthStart("vercel", {
        ...(routingCase.callbackTarget === undefined
          ? {}
          : { callbackTarget: routingCase.callbackTarget }),
        headers: authHeaders(),
        origin: routingCase.origin,
      });

      expect(response.status).toBe(200);
      const authorizationUrl = await authorizationUrlFromResponse(response);
      expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
        `https://vercel.com/integrations/${VERCEL_INTEGRATION_SLUG}/new`,
      );
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBeNull();
      const state = authorizationUrl.searchParams.get("state") ?? "";
      expect(state).toMatch(/^[0-9a-f]{64}$/u);

      const location = await completeAppOauthCallback("vercel", state);

      expect(location.origin).toBe(routingCase.expectedLocationOrigin);
      expect(location.pathname).toBe("/connector/success");
      expect(tokenBodies).toHaveLength(1);
      expect(tokenBodies[0]?.get("redirect_uri")).toBe(
        routingCase.expectedRedirectUri,
      );
    },
  );

  it.each(REDIRECTING_DIRECT_OKOU_CONNECTOR_SLUGS)(
    "returns %s provider errors to the configured App callback",
    async (connectorSlug) => {
      mockEnv("APP_URL", "https://app.okou.ai");
      mockAuthenticatedSession();

      const response = await requestOauthStart(connectorSlug, {
        callbackTarget: "app",
        headers: authHeaders(),
        origin: API_ORIGIN,
      });

      expect(response.status).toBe(200);
      const authorizationUrl = await authorizationUrlFromResponse(response);
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        `https://app.okou.ai/connectors/${connectorSlug}/callback`,
      );
      expectOauthState(authorizationUrl);
      await rejectProviderAuthorization(authorizationUrl);
    },
  );

  it.each(REDIRECTING_DIRECT_OKOU_CONNECTOR_SLUGS)(
    "keeps an omitted %s callback target on the existing Web callback",
    async (connectorSlug) => {
      mockAuthenticatedSession();

      const response = await requestOauthStart(connectorSlug, {
        headers: authHeaders(),
        origin: API_ORIGIN,
      });

      expect(response.status).toBe(200);
      const authorizationUrl = await authorizationUrlFromResponse(response);
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        `${WEB_ORIGIN}/api/connectors/${connectorSlug}/callback`,
      );
      expectOauthState(authorizationUrl);
      await rejectProviderAuthorization(authorizationUrl);
    },
  );

  it("uses the direct Okou App callback for Notion and reuses its exact redirect URI", async () => {
    const tokenBodies: unknown[] = [];
    server.use(
      http.post(NOTION_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(await request.json());
        return HttpResponse.json({
          access_token: "notion-test-token",
          refresh_token: "notion-refresh-token",
          expires_in: 3600,
          owner: {
            user: {
              id: "notion-user-123",
              name: "Notion Test User",
              person: { email: "notion@example.test" },
            },
          },
        });
      }),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("notion", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://api.notion.com/v1/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "notion-test-client-id",
    );
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBe("https://app.okou.ai/connectors/notion/callback");
    const state = expectOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${API_ORIGIN}/api/connectors/notion/callback?${new URLSearchParams({
        code: "notion-authorization-code",
        state,
      })}`,
      { headers: { "x-okou-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.origin).toBe("https://app.okou.ai");
    expect(callbackLocation.pathname).toBe("/connector/success");
    expect(tokenBodies).toStrictEqual([
      {
        grant_type: "authorization_code",
        code: "notion-authorization-code",
        redirect_uri: redirectUri,
      },
    ]);
  });

  it("returns Notion provider errors to the configured App callback", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("notion", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/connectors/notion/callback",
    );
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("keeps an omitted Notion callback target on the existing Web callback", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("notion", {
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}/api/connectors/notion/callback`,
    );
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it.each(LAUNCH_GATED_DIRECT_OKOU_CASES)(
    "uses the direct Okou App callback for $label and reuses its exact redirect URI",
    async (providerCase) => {
      const tokenBodies: URLSearchParams[] = [];
      server.use(
        http.post(providerCase.tokenUrl, async ({ request }) => {
          if ("publicClientId" in providerCase) {
            expect(request.headers.get("authorization")).toBeNull();
          }
          tokenBodies.push(
            launchGatedTokenRequestParams(providerCase, await request.text()),
          );
          return HttpResponse.json(providerCase.tokenResponse);
        }),
      );
      providerCase.mockUserInfo?.();
      mockEnv("APP_URL", "https://app.okou.ai");
      mockAuthenticatedSession();

      const response = await requestOauthStart(providerCase.connectorSlug, {
        callbackTarget: "app",
        headers: authHeaders(),
        origin: API_ORIGIN,
      });

      expect(response.status).toBe(200);
      const authorizationUrl = await authorizationUrlFromResponse(response);
      expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
        providerCase.authorizationEndpoint,
      );
      expect(authorizationUrl.searchParams.get("client_id")).toBe(
        launchGatedClientId(providerCase),
      );
      const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
      expect(redirectUri).toBe(
        `https://app.okou.ai/connectors/${providerCase.connectorSlug}/callback`,
      );
      // A `null` expectation proves the non-PKCE providers still send no
      // challenge and no verifier.
      const pkceValue = expect.stringMatching(/^[A-Za-z0-9_-]+$/u);
      const expectedCodeChallenge =
        providerCase.pkce === true ? pkceValue : null;
      const expectedCodeChallengeMethod =
        providerCase.pkce === true ? "S256" : null;
      expect(authorizationUrl.searchParams.get("code_challenge")).toStrictEqual(
        expectedCodeChallenge,
      );
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
        expectedCodeChallengeMethod,
      );
      const state = expectOauthState(authorizationUrl);

      const location = await completeLaunchGatedOauthCallback(
        providerCase,
        state,
      );

      expect(location.origin).toBe("https://app.okou.ai");
      expect(location.pathname).toBe("/connector/success");
      // A `null` expectation also proves Garmin Connect still replays no
      // redirect URI on its token request.
      const expectedTokenRedirectUri =
        providerCase.omitsTokenRedirectUri === true ? null : redirectUri;
      const expectedCodeVerifier =
        providerCase.pkce === true ? pkceValue : null;
      expect(tokenBodies).toHaveLength(1);
      expect(tokenBodies[0]?.get("redirect_uri")).toBe(
        expectedTokenRedirectUri,
      );
      expect(tokenBodies[0]?.get("code_verifier")).toStrictEqual(
        expectedCodeVerifier,
      );
      if (providerCase.pkce === true) {
        const codeVerifier = z
          .string()
          .parse(tokenBodies[0]?.get("code_verifier"));
        expect(authorizationUrl.searchParams.get("code_challenge")).toBe(
          createHash("sha256").update(codeVerifier).digest("base64url"),
        );
      }
      if ("publicClientId" in providerCase) {
        expect(tokenBodies[0]?.get("client_id")).toBe(
          providerCase.publicClientId,
        );
        expect(tokenBodies[0]?.get("client_secret")).toBeNull();
      }
    },
  );

  it.each(LAUNCH_GATED_DIRECT_OKOU_CONNECTOR_SLUGS)(
    "returns %s provider errors to the configured App callback",
    async (connectorSlug) => {
      mockEnv("APP_URL", "https://app.okou.ai");
      mockAuthenticatedSession();

      const response = await requestOauthStart(connectorSlug, {
        callbackTarget: "app",
        headers: authHeaders(),
        origin: API_ORIGIN,
      });

      expect(response.status).toBe(200);
      const authorizationUrl = await authorizationUrlFromResponse(response);
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        `https://app.okou.ai/connectors/${connectorSlug}/callback`,
      );
      expectOauthState(authorizationUrl);
      await rejectProviderAuthorization(authorizationUrl);
    },
  );

  it.each(LAUNCH_GATED_DIRECT_OKOU_CONNECTOR_SLUGS)(
    "keeps an omitted %s callback target on the existing Web callback",
    async (connectorSlug) => {
      mockAuthenticatedSession();

      const response = await requestOauthStart(connectorSlug, {
        headers: authHeaders(),
        origin: API_ORIGIN,
      });

      expect(response.status).toBe(200);
      const authorizationUrl = await authorizationUrlFromResponse(response);
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        `${WEB_ORIGIN}/api/connectors/${connectorSlug}/callback`,
      );
      expectOauthState(authorizationUrl);
      await rejectProviderAuthorization(authorizationUrl);
    },
  );

  it("uses the configured App callback for a catalog OAuth connector", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("test-oauth", {
      headers: authHeaders(),
      origin: API_ORIGIN,
      callbackTarget: "app",
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/connectors/test-oauth/callback",
    );
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("uses the direct Okou App callback for Cloudflare and reuses its exact redirect URI", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(CLOUDFLARE_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "cloudflare-test-token",
          refresh_token: "cloudflare-refresh-token",
          expires_in: 3600,
          scope: "offline_access",
        });
      }),
      http.get(CLOUDFLARE_USERINFO_URL, () => {
        return HttpResponse.json({
          sub: "cloudflare-user-123",
          email: "cloudflare@example.test",
          name: "Cloudflare Test User",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("cloudflare", {
      headers: authHeaders(),
      origin: API_ORIGIN,
      callbackTarget: "app",
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://dash.cloudflare.com/oauth2/auth",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "cloudflare-test-client-id",
    );
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBe(
      "https://app.okou.ai/connectors/cloudflare/callback",
    );
    expectCloudflareAuthorizationScopes(authorizationUrl);
    const state = expectOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${API_ORIGIN}/api/connectors/cloudflare/callback?${new URLSearchParams({
        code: "cloudflare-authorization-code",
        state,
      })}`,
      { headers: { "x-okou-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.origin).toBe("https://app.okou.ai");
    expect(callbackLocation.pathname).toBe("/connector/success");
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);
  });

  it("returns Cloudflare provider errors to the configured App callback", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("cloudflare", {
      headers: authHeaders(),
      origin: API_ORIGIN,
      callbackTarget: "app",
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://dash.cloudflare.com/oauth2/auth",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "cloudflare-test-client-id",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/connectors/cloudflare/callback",
    );
    expectCloudflareAuthorizationScopes(authorizationUrl);
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("keeps an omitted Cloudflare callback target on the existing API callback", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("cloudflare", {
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/connectors/cloudflare/callback`,
    );
    expectCloudflareAuthorizationScopes(authorizationUrl);
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("uses the direct Okou App callback for Slack", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("slack", {
      headers: authHeaders(),
      origin: API_ORIGIN,
      callbackTarget: "app",
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/connectors/slack/callback",
    );
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("keeps API-origin OAuth callbacks on the PR API when WWW uses Omby staging", async () => {
    mockAuthenticatedSession();
    mockEnv("OKOU_API_BACKEND_URL", "https://pr-19337-api.vm6.ai");
    mockEnv("OKOU_WEB_URL", "https://staging-www.omby.ai");

    const response = await requestOauthStart("cloudflare", {
      headers: authHeaders(),
      origin: "https://pr-19337-api.vm6.ai",
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://pr-19337-api.vm6.ai/api/connectors/cloudflare/callback",
    );
    expectCloudflareAuthorizationScopes(authorizationUrl);
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("uses the canonical API origin when OKOU_API_BACKEND_URL is localhost", async () => {
    mockAuthenticatedSession();
    mockEnv("OKOU_API_BACKEND_URL", LOCAL_ORIGIN);
    mockEnv("OKOU_WEB_URL", WEB_ORIGIN);

    const response = await requestOauthStart("cloudflare", {
      headers: authHeaders(),
      origin: LOCAL_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/connectors/cloudflare/callback`,
    );
    expectCloudflareAuthorizationScopes(authorizationUrl);
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("keeps Cloudflare OAuth callbacks on the canonical API origin when OKOU_API_BACKEND_URL is a tunnel", async () => {
    mockAuthenticatedSession();
    mockEnv("OKOU_API_BACKEND_URL", "https://tunnel-liangyou-vm2-www.vm7.ai");
    mockEnv("OKOU_WEB_URL", "https://www.vm7.ai:8443");

    const response = await requestOauthStart("cloudflare", {
      headers: authHeaders(),
      origin: "https://www.vm7.ai:8443",
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://api.vm7.ai:8443/api/connectors/cloudflare/callback",
    );
    expectCloudflareAuthorizationScopes(authorizationUrl);
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("returns 401 instead of relying on browser cookies when unauthenticated", async () => {
    const response = await requestOauthStart("github");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 400 when starting OAuth for a connector without an auth-code grant", async () => {
    const response = await requestOauthStart("serpapi", {
      authenticated: true,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "serpapi connector does not use an auth-code grant",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 400 when starting browser OAuth for a device authorization connector", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("test-oauth-device", {
      headers: authHeaders(),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "test-oauth-device connector does not use an auth-code grant",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 400 when starting OAuth with a missing selected auth method", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("github", {
      authMethod: "api-token",
      headers: authHeaders(),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "github connector does not have api-token auth method",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 403 when the auth method lacks executable platform configuration", async () => {
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", undefined);
    await installApiTestConnectorCatalog();
    mockAuthenticatedSession();

    const response = await requestOauthStart("github", {
      headers: authHeaders(),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "github connector is not available",
        code: "FORBIDDEN",
      },
    });
  });
});
