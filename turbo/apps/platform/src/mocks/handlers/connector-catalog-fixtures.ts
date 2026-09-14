import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogCategoryMetadata,
  PublicConnectorCatalogIcon,
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogPermissionSummary,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";

interface TestConnectorAuthMethod {
  readonly detail: PublicConnectorCatalogAuthMethodDetail;
  readonly requestedScopes: readonly string[];
  readonly supportsRefresh: boolean;
}

export interface TestConnectorCatalogDefinition {
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
  readonly description: string;
  readonly icon: PublicConnectorCatalogIcon;
  readonly category: string;
  readonly generation: readonly string[];
  readonly tags: readonly string[];
  readonly authMethods: readonly TestConnectorAuthMethod[];
  readonly permissionSummary: PublicConnectorCatalogPermissionSummary;
  readonly connectNotice: "google-security-warning" | null;
}

const NO_PERMISSIONS = {
  hasPermissions: false,
  permissionCount: 0,
  hasCategories: false,
  hasDefaultPolicyOverrides: false,
} satisfies PublicConnectorCatalogPermissionSummary;

function icon(connectorSlug: ConnectorSlug): PublicConnectorCatalogIcon {
  return {
    url: `https://icons.example.test/${connectorSlug}.svg`,
    invertInDarkMode: connectorSlug === "github",
  };
}

function authCodeMethod(
  args: {
    readonly requestedScopes?: readonly string[];
    readonly supportsRefresh?: boolean;
  } = {},
): TestConnectorAuthMethod {
  return {
    detail: {
      id: "oauth",
      label: "OAuth (Recommended)",
      description: "Sign in to grant access.",
      grantKind: "auth-code",
      manualFields: [],
      startOptions: [],
    },
    requestedScopes: args.requestedScopes ?? [],
    supportsRefresh: args.supportsRefresh ?? true,
  };
}

function manualMethod(
  id: ConnectorAuthMethodId,
  label: string,
  fields: PublicConnectorCatalogAuthMethodDetail["manualFields"],
): TestConnectorAuthMethod {
  return {
    detail: {
      id,
      label,
      description: `Enter the ${label.toLowerCase()} credentials.`,
      grantKind: "manual",
      manualFields: fields,
      startOptions: [],
    },
    requestedScopes: [],
    supportsRefresh: false,
  };
}

function externalCodeMethod(args: {
  readonly id: ConnectorAuthMethodId;
  readonly label: string;
  readonly description: string;
}): TestConnectorAuthMethod {
  return {
    detail: {
      id: args.id,
      label: args.label,
      description: args.description,
      grantKind: "external-code",
      manualFields: [],
      startOptions: [],
    },
    requestedScopes: [],
    supportsRefresh: true,
  };
}

function oauthConnector(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly tags?: readonly string[];
  readonly requestedScopes?: readonly string[];
  readonly permissionDetail?: PublicConnectorCatalogPermissionDetail;
}): TestConnectorCatalogDefinition {
  return {
    connectorSlug: args.connectorSlug,
    label: args.label,
    description: args.description,
    icon: icon(args.connectorSlug),
    category: args.category,
    generation: [],
    tags: args.tags ?? [],
    authMethods: [
      authCodeMethod(
        args.requestedScopes ? { requestedScopes: args.requestedScopes } : {},
      ),
    ],
    permissionSummary:
      args.permissionDetail === undefined
        ? NO_PERMISSIONS
        : permissionSummary(args.permissionDetail),
    connectNotice: null,
  };
}

const axiomPermissions = {
  connectorSlug: "axiom",
  label: "Axiom",
  icon: icon("axiom"),
  permissionCount: 3,
  permissions: [
    {
      name: "annotations|create",
      description: "Create Axiom annotations.",
    },
    { name: "dashboards|read", description: "Read Axiom dashboards." },
    { name: "datasets|read", description: "Read Axiom datasets." },
  ],
  categories: null,
  defaultPolicy: {
    permissionDefault: "allow",
    unknownPolicy: "allow",
  },
} satisfies PublicConnectorCatalogPermissionDetail;

const slackPermissions = {
  connectorSlug: "slack",
  label: "Slack",
  icon: icon("slack"),
  permissionCount: 6,
  permissions: [
    { name: "bookmarks:read", description: "List channel bookmarks." },
    { name: "files:read", description: "Read shared files." },
    { name: "bookmarks:write", description: "Manage channel bookmarks." },
    { name: "channels:join", description: "Join public channels." },
    { name: "openid", description: "Read the connected identity." },
    {
      name: "admin.analytics:read",
      description: "Access workspace analytics data",
    },
  ],
  categories: {
    categories: {
      "bookmarks:read": "Read",
      "files:read": "Read",
      "bookmarks:write": "Write",
      "channels:join": "Misc",
      openid: "Misc",
      "admin.analytics:read": "Admin",
    },
    displayOrder: ["Read", "Write", "Admin", "Misc"],
  },
  defaultPolicy: {
    permissionDefault: "deny",
    permissionOverrides: {
      allow: ["bookmarks:read"],
    },
    unknownPolicy: "allow",
  },
} satisfies PublicConnectorCatalogPermissionDetail;

const cloudflarePermissionNames = [
  "access-app.read",
  "access-audit-log.read",
  "account-analytics.read",
  "account-api-tokens.read",
  "account-dns-settings.read",
  "account-settings.read",
  "ai-search.read",
  "analytics.read",
  "api-gateway.read",
  "argotunnel.read",
  "browser-rendering.read",
  "cache.purge",
  "cloud-connector.read",
  "containers.read",
  "d1.read",
  "dns.read",
  "images.read",
  "logs.read",
  "notifications.read",
  "queues.read",
  "workers-r2.read",
  "memberships.read",
];

const cloudflarePermissions = {
  connectorSlug: "cloudflare",
  label: "Cloudflare",
  icon: icon("cloudflare"),
  permissionCount: cloudflarePermissionNames.length,
  permissions: cloudflarePermissionNames.map((name) => {
    return { name };
  }),
  categories: null,
  defaultPolicy: {
    permissionDefault: "allow",
    unknownPolicy: "deny",
  },
} satisfies PublicConnectorCatalogPermissionDetail;

const gmailPermissions = {
  connectorSlug: "gmail",
  label: "Gmail",
  icon: icon("gmail"),
  permissionCount: 1,
  permissions: [
    {
      name: "messages.write",
      description: "Create and update Gmail messages.",
    },
  ],
  categories: null,
  defaultPolicy: {
    permissionDefault: "deny",
    unknownPolicy: "allow",
  },
} satisfies PublicConnectorCatalogPermissionDetail;

const youtubePermissions = {
  connectorSlug: "youtube",
  label: "YouTube",
  icon: icon("youtube"),
  permissionCount: 1,
  permissions: [
    {
      name: "videos.write",
      description: "Create and update YouTube videos.",
    },
  ],
  categories: null,
  defaultPolicy: {
    permissionDefault: "deny",
    unknownPolicy: "allow",
  },
} satisfies PublicConnectorCatalogPermissionDetail;

export const testConnectorPermissionDetails = new Map<
  ConnectorSlug,
  PublicConnectorCatalogPermissionDetail
>([
  ["axiom", axiomPermissions],
  ["cloudflare", cloudflarePermissions],
  ["gmail", gmailPermissions],
  ["slack", slackPermissions],
  ["youtube", youtubePermissions],
]);

function permissionSummary(
  detail: PublicConnectorCatalogPermissionDetail,
): PublicConnectorCatalogPermissionSummary {
  return {
    hasPermissions: detail.permissionCount > 0,
    permissionCount: detail.permissionCount,
    hasCategories: detail.categories !== null,
    hasDefaultPolicyOverrides:
      detail.defaultPolicy.permissionOverrides !== undefined,
  };
}

const tokenField = [
  {
    id: "apiToken",
    label: "API Token",
    required: true,
    placeholder: null,
    inputType: "password",
  },
] satisfies PublicConnectorCatalogAuthMethodDetail["manualFields"];

export const testConnectorCatalogDefinitions = (
  [
    {
      connectorSlug: "ahrefs",
      label: "Ahrefs",
      description: "Access SEO data, backlink analysis, and keyword research.",
      icon: icon("ahrefs"),
      category: "marketing-content-growth",
      generation: [],
      tags: [],
      authMethods: [
        manualMethod("api-token", "API Token", [
          {
            id: "apiToken",
            label: "API Token",
            required: true,
            placeholder: "your-ahrefs-api-token",
            inputType: "password",
          },
        ]),
      ],
      permissionSummary: NO_PERMISSIONS,
      connectNotice: null,
    },
    oauthConnector({
      connectorSlug: "openai",
      label: "OpenAI",
      description: "Access OpenAI models and APIs.",
      category: "ai-general-models",
    }),
    {
      connectorSlug: "base44",
      label: "Base44",
      description: "Access and manage Base44 apps.",
      icon: icon("base44"),
      category: "ai-agent-apps",
      generation: [],
      tags: [],
      authMethods: [
        {
          detail: {
            id: "oauth",
            label: "OAuth",
            description: "Sign in with Base44 to grant access.",
            grantKind: "device-auth",
            manualFields: [],
            startOptions: [],
          },
          requestedScopes: [],
          supportsRefresh: true,
        },
      ],
      permissionSummary: NO_PERMISSIONS,
      connectNotice: null,
    },
    oauthConnector({
      connectorSlug: "slack",
      label: "Slack",
      description: "Send messages and read channels.",
      category: "communication-collaboration",
      tags: ["chat", "messaging", "im"],
      permissionDetail: slackPermissions,
    }),
    oauthConnector({
      connectorSlug: "gmail",
      label: "Gmail",
      description: "Read and manage Gmail messages.",
      category: "communication-collaboration",
      permissionDetail: gmailPermissions,
    }),
    oauthConnector({
      connectorSlug: "cal-com",
      label: "Cal.com",
      description: "Manage Cal.com bookings and schedules.",
      category: "meetings-scheduling",
    }),
    oauthConnector({
      connectorSlug: "google-calendar",
      label: "Google Calendar",
      description: "Manage Google Calendar events.",
      category: "meetings-scheduling",
    }),
    oauthConnector({
      connectorSlug: "zoom",
      label: "Zoom",
      description: "Manage Zoom meetings and recordings.",
      category: "meetings-scheduling",
    }),
    oauthConnector({
      connectorSlug: "box",
      label: "Box",
      description: "Access and manage Box files.",
      category: "docs-files-knowledge",
    }),
    oauthConnector({
      connectorSlug: "dropbox",
      label: "Dropbox",
      description: "Access and manage Dropbox files.",
      category: "docs-files-knowledge",
    }),
    oauthConnector({
      connectorSlug: "google-drive",
      label: "Google Drive",
      description: "Access Google Drive files and presentations.",
      category: "docs-files-knowledge",
    }),
    oauthConnector({
      connectorSlug: "google-sheets",
      label: "Google Sheets",
      description: "Read and update Google Sheets.",
      category: "docs-files-knowledge",
    }),
    oauthConnector({
      connectorSlug: "notion",
      label: "Notion",
      description: "Access Notion pages and databases.",
      category: "docs-files-knowledge",
    }),
    oauthConnector({
      connectorSlug: "github",
      label: "GitHub",
      description:
        "Connect your GitHub account to access repositories and GitHub features.",
      category: "engineering-team-execution",
      tags: ["gh", "git", "vcs", "scm", "repos"],
    }),
    oauthConnector({
      connectorSlug: "asana",
      label: "Asana",
      description:
        "Connect your Asana account to manage projects, tasks, and team workflows.",
      category: "engineering-team-execution",
    }),
    oauthConnector({
      connectorSlug: "cloudflare",
      label: "Cloudflare",
      description: "Manage Cloudflare infrastructure.",
      category: "engineering-team-execution",
      permissionDetail: cloudflarePermissions,
    }),
    oauthConnector({
      connectorSlug: "datadog",
      label: "Datadog",
      description: "Access Datadog observability data.",
      category: "engineering-team-execution",
    }),
    oauthConnector({
      connectorSlug: "sentry",
      label: "Sentry",
      description: "Access error tracking and project data.",
      category: "engineering-team-execution",
    }),
    oauthConnector({
      connectorSlug: "linear",
      label: "Linear",
      description: "Manage Linear issues and projects.",
      category: "engineering-team-execution",
    }),
    oauthConnector({
      connectorSlug: "hubspot",
      label: "HubSpot",
      description: "Manage HubSpot CRM data.",
      category: "sales-crm-business-operations",
    }),
    oauthConnector({
      connectorSlug: "quickbooks",
      label: "QuickBooks",
      description: "Access QuickBooks accounting data.",
      category: "sales-crm-business-operations",
    }),
    oauthConnector({
      connectorSlug: "google-ads",
      label: "Google Ads",
      description: "Manage Google Ads campaigns and reports.",
      category: "marketing-content-growth",
      tags: ["ads", "advertising", "campaigns"],
      requestedScopes: [
        "https://www.googleapis.com/auth/adwords",
        "https://www.googleapis.com/auth/datamanager",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    }),
    oauthConnector({
      connectorSlug: "mailchimp",
      label: "Mailchimp",
      description: "Manage Mailchimp audiences and campaigns.",
      category: "marketing-content-growth",
    }),
    oauthConnector({
      connectorSlug: "meta-ads",
      label: "Meta Ads",
      description: "Manage Meta Ads campaigns and audiences.",
      category: "marketing-content-growth",
    }),
    oauthConnector({
      connectorSlug: "tiktok-ads",
      label: "TikTok Ads",
      description: "Manage TikTok Ads campaigns.",
      category: "marketing-content-growth",
    }),
    oauthConnector({
      connectorSlug: "youtube",
      label: "YouTube",
      description: "Manage YouTube channels and videos.",
      category: "marketing-content-growth",
      permissionDetail: youtubePermissions,
    }),
    {
      connectorSlug: "axiom",
      label: "Axiom",
      description: "Query logs and manage observability data.",
      icon: icon("axiom"),
      category: "data-automation-infrastructure",
      generation: [],
      tags: ["logs", "observability"],
      authMethods: [manualMethod("api-token", "API Token", tokenField)],
      permissionSummary: permissionSummary(axiomPermissions),
      connectNotice: null,
    },
    {
      connectorSlug: "aws",
      label: "AWS",
      description: "Connect a temporary AWS session.",
      icon: icon("aws"),
      category: "data-automation-infrastructure",
      generation: [],
      tags: ["cloud", "infrastructure", "storage", "compute"],
      authMethods: [
        externalCodeMethod({
          id: "cli",
          label: "Sign in with AWS",
          description:
            "Sign in with AWS and paste the authorization code. This temporary AWS connector expires after up to 12 hours.",
        }),
      ],
      permissionSummary: NO_PERMISSIONS,
      connectNotice: null,
    },
    {
      connectorSlug: "cloudinary",
      label: "Cloudinary",
      description: "Manage Cloudinary media assets.",
      icon: icon("cloudinary"),
      category: "marketing-content-growth",
      generation: [],
      tags: [],
      authMethods: [
        manualMethod("api-token", "API Credentials", [
          {
            id: "apiKey",
            label: "API Key",
            required: true,
            placeholder: null,
            inputType: "password",
          },
          {
            id: "apiSecret",
            label: "API Secret",
            required: true,
            placeholder: null,
            inputType: "password",
          },
          {
            id: "cloudName",
            label: "Cloud Name",
            required: true,
            placeholder: "your-cloud-name",
            inputType: "text",
          },
        ]),
      ],
      permissionSummary: NO_PERMISSIONS,
      connectNotice: null,
    },
    oauthConnector({
      connectorSlug: "google-maps",
      label: "Google Maps",
      description: "Access Google Maps Platform APIs.",
      category: "data-automation-infrastructure",
    }),
    {
      connectorSlug: "plausible",
      label: "Plausible",
      description: "Access website traffic analytics and visitor stats.",
      icon: icon("plausible"),
      category: "data-automation-infrastructure",
      generation: [],
      tags: ["analytics", "traffic"],
      authMethods: [
        manualMethod("api-token", "API Key", [
          {
            id: "apiKey",
            label: "API Key",
            required: true,
            placeholder: "your-plausible-api-key",
            inputType: "password",
          },
        ]),
      ],
      permissionSummary: NO_PERMISSIONS,
      connectNotice: null,
    },
    {
      connectorSlug: "revenuecat",
      label: "RevenueCat",
      description: "Access subscriptions, purchases, and customer data.",
      icon: icon("revenuecat"),
      category: "data-automation-infrastructure",
      generation: [],
      tags: ["subscriptions", "revenue"],
      authMethods: [
        manualMethod("api-token", "Secret API Key", [
          {
            id: "secretApiKey",
            label: "Secret API Key",
            required: true,
            placeholder: "sk_xxxxxxxxxxxxxxxx",
            inputType: "password",
          },
        ]),
      ],
      permissionSummary: NO_PERMISSIONS,
      connectNotice: null,
    },
    {
      connectorSlug: "playstation",
      label: "PlayStation",
      description: "Access PlayStation Network player data.",
      icon: icon("playstation"),
      category: "data-automation-infrastructure",
      generation: [],
      tags: ["gaming", "player", "psn"],
      authMethods: [
        externalCodeMethod({
          id: "api",
          label: "PlayStation sign-in",
          description: "Paste the PlayStation authorization value.",
        }),
      ],
      permissionSummary: NO_PERMISSIONS,
      connectNotice: null,
    },
    {
      connectorSlug: "steam",
      label: "Steam",
      description: "Access Steam player and game data.",
      icon: icon("steam"),
      category: "data-automation-infrastructure",
      generation: [],
      tags: ["gaming", "player"],
      authMethods: [
        {
          detail: {
            id: "openid",
            label: "Steam sign-in",
            description: "Sign in with Steam to connect your player account.",
            grantKind: "openid-auth",
            manualFields: [],
            startOptions: [],
          },
          requestedScopes: [],
          supportsRefresh: false,
        },
      ],
      permissionSummary: NO_PERMISSIONS,
      connectNotice: null,
    },
    {
      connectorSlug: "stripe",
      label: "Stripe",
      description: "Manage payments, customers, and subscriptions.",
      icon: icon("stripe"),
      category: "data-automation-infrastructure",
      generation: [],
      tags: ["payments", "billing", "checkout"],
      authMethods: [
        authCodeMethod(),
        {
          detail: {
            id: "cli",
            label: "Sign in with Stripe",
            description: "Approve access in the Stripe Dashboard.",
            grantKind: "device-auth",
            manualFields: [],
            startOptions: [
              {
                id: "mode",
                kind: "select",
                label: "Mode",
                required: true,
                defaultValue: "test",
                options: [
                  { value: "test", label: "Test" },
                  { value: "live", label: "Live" },
                ],
              },
            ],
          },
          requestedScopes: [],
          supportsRefresh: false,
        },
        manualMethod("api-token", "API Key", tokenField),
      ],
      permissionSummary: NO_PERMISSIONS,
      connectNotice: null,
    },
  ] satisfies TestConnectorCatalogDefinition[]
).sort((left, right) => {
  return left.connectorSlug.localeCompare(right.connectorSlug);
});

export const testConnectorCatalogCategoryMetadata = {
  categories: [
    {
      id: "ai-general-models",
      label: "General Models and Reasoning",
      menuLabel: "General Models",
      groupId: "ai",
    },
    {
      id: "ai-agent-apps",
      label: "Agent Platforms and AI Apps",
      menuLabel: "Agent Platforms",
      groupId: "ai",
    },
    {
      id: "communication-collaboration",
      label: "Communication and Collaboration",
      menuLabel: "Communication",
      groupId: null,
    },
    {
      id: "meetings-scheduling",
      label: "Meetings and Scheduling",
      menuLabel: "Meetings",
      groupId: null,
    },
    {
      id: "docs-files-knowledge",
      label: "Docs, Files, and Knowledge",
      menuLabel: "Documents",
      groupId: null,
    },
    {
      id: "engineering-team-execution",
      label: "Engineering and Team Execution",
      menuLabel: "Engineering",
      groupId: null,
    },
    {
      id: "sales-crm-business-operations",
      label: "Sales, CRM, and Business Operations",
      menuLabel: "Sales and Business",
      groupId: null,
    },
    {
      id: "marketing-content-growth",
      label: "Marketing, Content, and Growth",
      menuLabel: "Marketing",
      groupId: null,
    },
    {
      id: "data-automation-infrastructure",
      label: "Data, Automation, and Infrastructure",
      menuLabel: "Data and Automation",
      groupId: null,
    },
  ],
  groups: [{ id: "ai", label: "AI", menuLabel: "AI" }],
} satisfies PublicConnectorCatalogCategoryMetadata;
