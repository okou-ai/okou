import type { ConnectorAuthMethodRuntimeConfig } from "../connector-config";
import type {
  ConnectorAuthClientForConfig,
  ConnectorAuthClientIdentityForConfig,
} from "../connector-auth-method";

export type ConnectorAuthProviderClientContract =
  | { readonly kind: "none" }
  | {
      readonly kind: "static-confidential-env";
      readonly clientIdEnv: string;
      readonly clientSecretEnv: string;
    }
  | { readonly kind: "static-confidential-literal" }
  | {
      readonly kind: "static-public-env";
      readonly clientIdEnv: string;
    }
  | { readonly kind: "static-public-literal" }
  | { readonly kind: "dynamic-public" };

export interface ConnectorAuthProviderMethodContract {
  readonly client: ConnectorAuthProviderClientContract;
  readonly grant: {
    readonly kind: ConnectorAuthMethodRuntimeConfig["grant"]["kind"];
    readonly callbackOrigin: "web" | "api" | null;
    readonly outputNames: readonly string[];
    readonly startOptionNames: readonly string[];
  };
  readonly access: {
    readonly kind: ConnectorAuthMethodRuntimeConfig["access"]["kind"];
    readonly inputNames: readonly string[];
    readonly outputNames: readonly string[];
    readonly platformSecrets: readonly string[];
  };
  readonly revoke: {
    readonly kind: ConnectorAuthMethodRuntimeConfig["revoke"]["kind"];
    readonly inputNames: readonly string[];
  };
}

interface ConnectorAuthProviderMethodRegistration {
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly contract: ConnectorAuthProviderMethodContract;
}

// This is Okou's executable compatibility contract, not connector catalog data.
// Keep it limited to facts required to select and validate provider handlers.
export const CONNECTOR_AUTH_PROVIDER_METHOD_REGISTRATIONS = [
  {
    connectorSlug: "ahrefs",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "AHREFS_OAUTH_CLIENT_ID",
        clientSecretEnv: "AHREFS_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "airtable",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "AIRTABLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "AIRTABLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "asana",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "ASANA_OAUTH_CLIENT_ID",
        clientSecretEnv: "ASANA_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "aws",
    authMethodId: "cli",
    contract: {
      client: {
        kind: "static-public-literal",
      },
      grant: {
        kind: "external-code",
        callbackOrigin: null,
        outputNames: [
          "accessKeyId",
          "dpopKey",
          "refreshToken",
          "runtimeRegion",
          "secretAccessKey",
          "sessionToken",
          "signinRegion",
        ],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["dpopKey", "refreshToken", "signinRegion"],
        outputNames: [
          "accessKeyId",
          "refreshToken",
          "secretAccessKey",
          "sessionToken",
        ],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "base44",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-public-literal",
      },
      grant: {
        kind: "device-auth",
        callbackOrigin: null,
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "box",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "BOX_OAUTH_CLIENT_ID",
        clientSecretEnv: "BOX_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "cal-com",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "CAL_COM_OAUTH_CLIENT_ID",
        clientSecretEnv: "CAL_COM_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "calendly",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "CALENDLY_OAUTH_CLIENT_ID",
        clientSecretEnv: "CALENDLY_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "token-revoke",
        inputNames: ["refreshToken"],
      },
    },
  },
  {
    connectorSlug: "canva",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "CANVA_OAUTH_CLIENT_ID",
        clientSecretEnv: "CANVA_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "close",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "CLOSE_OAUTH_CLIENT_ID",
        clientSecretEnv: "CLOSE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "cloudflare",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "CLOUDFLARE_OAUTH_CLIENT_ID",
        clientSecretEnv: "CLOUDFLARE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "api",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "token-revoke",
        inputNames: ["refreshToken"],
      },
    },
  },
  {
    connectorSlug: "copper",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "COPPER_OAUTH_CLIENT_ID",
        clientSecretEnv: "COPPER_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "datadog",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "DATADOG_OAUTH_CLIENT_ID",
        clientSecretEnv: "DATADOG_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "domain", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["domain", "refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "deel",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "DEEL_OAUTH_CLIENT_ID",
        clientSecretEnv: "DEEL_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "docusign",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "DOCUSIGN_OAUTH_CLIENT_ID",
        clientSecretEnv: "DOCUSIGN_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "dropbox",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "DROPBOX_OAUTH_CLIENT_ID",
        clientSecretEnv: "DROPBOX_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "figma",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "FIGMA_OAUTH_CLIENT_ID",
        clientSecretEnv: "FIGMA_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "garmin-connect",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GARMIN_CONNECT_OAUTH_CLIENT_ID",
        clientSecretEnv: "GARMIN_CONNECT_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "github",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GH_OAUTH_CLIENT_ID",
        clientSecretEnv: "GH_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "token-revoke",
        inputNames: ["accessToken"],
      },
    },
  },
  {
    connectorSlug: "gmail",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "google-ads",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: ["GOOGLE_ADS_DEVELOPER_TOKEN"],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "google-analytics",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "google-calendar",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "google-cloud",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "google-contacts",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "google-docs",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "google-drive",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "google-forms",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "google-maps",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "google-meet",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "google-search-console",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "google-sheets",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "gumroad",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GUMROAD_OAUTH_CLIENT_ID",
        clientSecretEnv: "GUMROAD_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "hubspot",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "HUBSPOT_OAUTH_CLIENT_ID",
        clientSecretEnv: "HUBSPOT_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "intervals-icu",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "INTERVALS_ICU_OAUTH_CLIENT_ID",
        clientSecretEnv: "INTERVALS_ICU_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "lark",
    authMethodId: "api-token",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "manual",
        callbackOrigin: null,
        outputNames: [],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["appId", "appSecret"],
        outputNames: ["accessToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "linear",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "LINEAR_OAUTH_CLIENT_ID",
        clientSecretEnv: "LINEAR_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "token-revoke",
        inputNames: ["accessToken"],
      },
    },
  },
  {
    connectorSlug: "mailchimp",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "MAILCHIMP_OAUTH_CLIENT_ID",
        clientSecretEnv: "MAILCHIMP_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "mercury",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "MERCURY_OAUTH_CLIENT_ID",
        clientSecretEnv: "MERCURY_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "meta-ads",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "META_ADS_OAUTH_CLIENT_ID",
        clientSecretEnv: "META_ADS_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "microsoft-365",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
        clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "monday",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "MONDAY_OAUTH_CLIENT_ID",
        clientSecretEnv: "MONDAY_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "neon",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "NEON_OAUTH_CLIENT_ID",
        clientSecretEnv: "NEON_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "netsuite",
    authMethodId: "api-token",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "manual",
        callbackOrigin: null,
        outputNames: [],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: [
          "accountSubdomain",
          "clientId",
          "clientSecret",
          "refreshToken",
        ],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "nintendo-store",
    authMethodId: "api",
    contract: {
      client: {
        kind: "static-public-literal",
      },
      grant: {
        kind: "external-code",
        callbackOrigin: null,
        outputNames: [
          "accessToken",
          "accountId",
          "idToken",
          "locale",
          "sessionToken",
        ],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["sessionToken"],
        outputNames: ["accessToken", "idToken", "locale"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "nintendo-switch-parental-controls",
    authMethodId: "api",
    contract: {
      client: {
        kind: "static-public-literal",
      },
      grant: {
        kind: "external-code",
        callbackOrigin: null,
        outputNames: [
          "accessToken",
          "accountId",
          "deviceCatalog",
          "idToken",
          "language",
          "sessionToken",
          "smartDeviceId",
        ],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["language", "sessionToken", "smartDeviceId"],
        outputNames: ["accessToken", "deviceCatalog", "idToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "token-revoke",
        inputNames: ["sessionToken", "smartDeviceId"],
      },
    },
  },
  {
    connectorSlug: "notion",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "NOTION_OAUTH_CLIENT_ID",
        clientSecretEnv: "NOTION_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "optimizely-cmp",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "OPTIMIZELY_CMP_OAUTH_CLIENT_ID",
        clientSecretEnv: "OPTIMIZELY_CMP_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "token-revoke",
        inputNames: ["refreshToken"],
      },
    },
  },
  {
    connectorSlug: "oto",
    authMethodId: "api-token",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "manual",
        callbackOrigin: null,
        outputNames: [],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "noyo",
    authMethodId: "api-token",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "manual",
        callbackOrigin: null,
        outputNames: [],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["clientId", "clientSecret"],
        outputNames: ["accessToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "resource-guru",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "RESOURCE_GURU_OAUTH_CLIENT_ID",
        clientSecretEnv: "RESOURCE_GURU_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "outlook-calendar",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
        clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "outlook-mail",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
        clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "paypal",
    authMethodId: "api-token",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "manual",
        callbackOrigin: null,
        outputNames: [],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["clientId", "clientSecret"],
        outputNames: ["accessToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "procountor",
    authMethodId: "api-token",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "manual",
        callbackOrigin: null,
        outputNames: [],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["apiKey", "clientId", "clientSecret", "redirectUri"],
        outputNames: ["accessToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "playstation",
    authMethodId: "api",
    contract: {
      client: {
        kind: "static-public-literal",
      },
      grant: {
        kind: "external-code",
        callbackOrigin: null,
        outputNames: [
          "accessToken",
          "accountId",
          "idToken",
          "onlineId",
          "refreshToken",
        ],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "idToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "posthog",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-public-literal",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "baseUrl", "refreshToken", "region"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["baseUrl", "refreshToken", "region"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "quickbooks",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "QUICKBOOKS_OAUTH_CLIENT_ID",
        clientSecretEnv: "QUICKBOOKS_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "realmId", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "ramp",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "RAMP_OAUTH_CLIENT_ID",
        clientSecretEnv: "RAMP_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "token-revoke",
        inputNames: ["accessToken", "refreshToken"],
      },
    },
  },
  {
    connectorSlug: "reckon",
    authMethodId: "oauth-refresh-token",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "manual",
        callbackOrigin: null,
        outputNames: [],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["clientId", "clientSecret", "redirectUri", "refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "reddit",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "REDDIT_OAUTH_CLIENT_ID",
        clientSecretEnv: "REDDIT_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "sentry",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "SENTRY_OAUTH_CLIENT_ID",
        clientSecretEnv: "SENTRY_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "slack",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "SLACK_OAUTH_CLIENT_ID",
        clientSecretEnv: "SLACK_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "token-revoke",
        inputNames: ["accessToken"],
      },
    },
  },
  {
    connectorSlug: "slock",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "dynamic-public",
      },
      grant: {
        kind: "device-auth",
        callbackOrigin: null,
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "spotify",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "SPOTIFY_OAUTH_CLIENT_ID",
        clientSecretEnv: "SPOTIFY_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "steam",
    authMethodId: "openid",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "openid-auth",
        callbackOrigin: "api",
        outputNames: ["steamId"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: ["STEAM_WEB_API_KEY"],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "strava",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "STRAVA_OAUTH_CLIENT_ID",
        clientSecretEnv: "STRAVA_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "stripe",
    authMethodId: "cli",
    contract: {
      client: {
        kind: "dynamic-public",
      },
      grant: {
        kind: "device-auth",
        callbackOrigin: null,
        outputNames: ["token"],
        startOptionNames: ["mode"],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "stripe",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "STRIPE_OAUTH_CLIENT_ID",
        clientSecretEnv: "STRIPE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "livemode", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "supabase",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "SUPABASE_OAUTH_CLIENT_ID",
        clientSecretEnv: "SUPABASE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "test-oauth",
    authMethodId: "api",
    contract: {
      client: {
        kind: "static-confidential-literal",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "api",
        outputNames: ["initialAccessToken", "initialRefreshToken", "tenantId"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["apiRefreshToken", "tenantId"],
        outputNames: [
          "refreshedAccessToken",
          "refreshedRefreshToken",
          "refreshedTenantId",
          "secondaryToken",
        ],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "test-oauth",
    authMethodId: "api-token",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "manual",
        callbackOrigin: null,
        outputNames: [],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["inputSecret", "inputVariable"],
        outputNames: ["accessToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "test-oauth",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-literal",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "api",
        outputNames: ["accessToken", "refreshToken", "tenantId"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "test-oauth-device",
    authMethodId: "api",
    contract: {
      client: {
        kind: "static-public-literal",
      },
      grant: {
        kind: "device-auth",
        callbackOrigin: null,
        outputNames: ["accessToken"],
        startOptionNames: ["mode"],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "test-oauth-device",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-public-literal",
      },
      grant: {
        kind: "device-auth",
        callbackOrigin: null,
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "tiktok-ads",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "TIKTOK_ADS_OAUTH_CLIENT_ID",
        clientSecretEnv: "TIKTOK_ADS_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "todoist",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "TODOIST_OAUTH_CLIENT_ID",
        clientSecretEnv: "TODOIST_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "vercel",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "VERCEL_OAUTH_CLIENT_ID",
        clientSecretEnv: "VERCEL_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "webflow",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "WEBFLOW_OAUTH_CLIENT_ID",
        clientSecretEnv: "WEBFLOW_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "workday",
    authMethodId: "api-token",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "manual",
        callbackOrigin: null,
        outputNames: [],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: [
          "clientId",
          "clientSecret",
          "host",
          "refreshToken",
          "tenant",
        ],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "x",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "X_OAUTH_CLIENT_ID",
        clientSecretEnv: "X_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "xero",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "XERO_OAUTH_CLIENT_ID",
        clientSecretEnv: "XERO_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorSlug: "youtube",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "token-revoke",
        inputNames: ["refreshToken"],
      },
    },
  },
  {
    connectorSlug: "zoom",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "ZOOM_OAUTH_CLIENT_ID",
        clientSecretEnv: "ZOOM_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
] as const satisfies readonly ConnectorAuthProviderMethodRegistration[];

type ConnectorAuthProviderMethodRegistrationEntry =
  (typeof CONNECTOR_AUTH_PROVIDER_METHOD_REGISTRATIONS)[number];

export type ConnectorAuthProviderConnectorSlug =
  ConnectorAuthProviderMethodRegistrationEntry["connectorSlug"];

type ConnectorAuthProviderMethodRegistrationMap = {
  readonly [ConnectorSlug in ConnectorAuthProviderConnectorSlug]: {
    readonly [AuthMethodId in Extract<
      ConnectorAuthProviderMethodRegistrationEntry,
      { readonly connectorSlug: ConnectorSlug }
    >["authMethodId"]]: Extract<
      ConnectorAuthProviderMethodRegistrationEntry,
      {
        readonly connectorSlug: ConnectorSlug;
        readonly authMethodId: AuthMethodId;
      }
    >;
  };
};

export type ConnectorAuthProviderAuthMethodId<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
> = keyof ConnectorAuthProviderMethodRegistrationMap[ConnectorSlug] & string;

export type ConnectorAuthProviderMethodRegistrationFor<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> = ConnectorAuthProviderMethodRegistrationMap[ConnectorSlug][AuthMethodId];

type ConnectorAuthProviderMethodRegistrationForConnector<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
> =
  ConnectorAuthProviderMethodRegistrationMap[ConnectorSlug][ConnectorAuthProviderAuthMethodId<ConnectorSlug>];

type RegistrationByGrantKind<
  Registration,
  Kind extends ConnectorAuthMethodRuntimeConfig["grant"]["kind"],
> = Registration extends {
  readonly contract: { readonly grant: { readonly kind: Kind } };
}
  ? Registration
  : never;

type RegistrationByAccessKind<
  Registration,
  Kind extends ConnectorAuthMethodRuntimeConfig["access"]["kind"],
> = Registration extends {
  readonly contract: { readonly access: { readonly kind: Kind } };
}
  ? Registration
  : never;

type RegistrationByRevokeKind<
  Registration,
  Kind extends ConnectorAuthMethodRuntimeConfig["revoke"]["kind"],
> = Registration extends {
  readonly contract: { readonly revoke: { readonly kind: Kind } };
}
  ? Registration
  : never;

export type ConnectorAuthProviderConnectorSlugByGrantKind<
  Kind extends ConnectorAuthMethodRuntimeConfig["grant"]["kind"],
> = RegistrationByGrantKind<
  ConnectorAuthProviderMethodRegistrationEntry,
  Kind
>["connectorSlug"];

export type ConnectorAuthProviderAuthMethodIdByGrantKind<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  Kind extends ConnectorAuthMethodRuntimeConfig["grant"]["kind"],
> = ConnectorAuthProviderAuthMethodId<ConnectorSlug> &
  RegistrationByGrantKind<
    ConnectorAuthProviderMethodRegistrationForConnector<ConnectorSlug>,
    Kind
  >["authMethodId"];

export type ConnectorAuthProviderConnectorSlugByAccessKind<
  Kind extends ConnectorAuthMethodRuntimeConfig["access"]["kind"],
> = RegistrationByAccessKind<
  ConnectorAuthProviderMethodRegistrationEntry,
  Kind
>["connectorSlug"];

export type ConnectorAuthProviderAuthMethodIdByAccessKind<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  Kind extends ConnectorAuthMethodRuntimeConfig["access"]["kind"],
> = ConnectorAuthProviderAuthMethodId<ConnectorSlug> &
  RegistrationByAccessKind<
    ConnectorAuthProviderMethodRegistrationForConnector<ConnectorSlug>,
    Kind
  >["authMethodId"];

export type ConnectorAuthProviderAuthMethodIdByRevokeKind<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  Kind extends ConnectorAuthMethodRuntimeConfig["revoke"]["kind"],
> = ConnectorAuthProviderAuthMethodId<ConnectorSlug> &
  RegistrationByRevokeKind<
    ConnectorAuthProviderMethodRegistrationForConnector<ConnectorSlug>,
    Kind
  >["authMethodId"];

type ConnectorAuthProviderClientConfigForContract<
  Contract extends ConnectorAuthProviderClientContract,
> = Contract["kind"] extends "static-confidential-env"
  ? {
      readonly clientRegistration: "static";
      readonly clientType: "confidential";
      readonly clientIdEnv: string;
      readonly clientSecretEnv: string;
    }
  : Contract["kind"] extends "static-confidential-literal"
    ? {
        readonly clientRegistration: "static";
        readonly clientType: "confidential";
        readonly clientId: string;
        readonly clientSecret: string;
      }
    : Contract["kind"] extends "static-public-env"
      ? {
          readonly clientRegistration: "static";
          readonly clientType: "public";
          readonly clientIdEnv: string;
        }
      : Contract["kind"] extends "static-public-literal"
        ? {
            readonly clientRegistration: "static";
            readonly clientType: "public";
            readonly clientId: string;
          }
        : Contract["kind"] extends "dynamic-public"
          ? {
              readonly clientRegistration: "dynamic";
              readonly clientType: "public";
            }
          : never;

type ConnectorAuthProviderClientConfigFor<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> = ConnectorAuthProviderClientConfigForContract<
  ConnectorAuthProviderMethodRegistrationFor<
    ConnectorSlug,
    AuthMethodId
  >["contract"]["client"]
>;

export type ConnectorAuthProviderClientFor<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> = ConnectorAuthClientForConfig<
  ConnectorAuthProviderClientConfigFor<ConnectorSlug, AuthMethodId>
>;

export type ConnectorAuthProviderClientIdentityFor<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> = ConnectorAuthClientIdentityForConfig<
  ConnectorAuthProviderClientConfigFor<ConnectorSlug, AuthMethodId>
>;

export type ConnectorAuthProviderGrantOutputValuesFor<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> = Readonly<
  Record<
    ConnectorAuthProviderMethodRegistrationFor<
      ConnectorSlug,
      AuthMethodId
    >["contract"]["grant"]["outputNames"][number],
    string | null | undefined
  >
>;

export type ConnectorAuthProviderRefreshInputValuesFor<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> = Readonly<
  Record<
    ConnectorAuthProviderMethodRegistrationFor<
      ConnectorSlug,
      AuthMethodId
    >["contract"]["access"]["inputNames"][number],
    string
  >
>;

export type ConnectorAuthProviderRefreshOutputValuesFor<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> = Readonly<
  Partial<
    Record<
      ConnectorAuthProviderMethodRegistrationFor<
        ConnectorSlug,
        AuthMethodId
      >["contract"]["access"]["outputNames"][number],
      string | undefined
    >
  >
>;

export type ConnectorAuthProviderRevokeInputValuesFor<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> = Readonly<
  Record<
    ConnectorAuthProviderMethodRegistrationFor<
      ConnectorSlug,
      AuthMethodId
    >["contract"]["revoke"]["inputNames"][number],
    string
  >
>;
