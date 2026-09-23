import { http, HttpResponse } from "msw";
import {
  connectorAuthMethodIdSchema,
  type ConnectorAuthMethodId,
} from "@okouai/api-contracts/contracts/connector-identity";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogItem,
  PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isConnectorAuthMethodId(
  value: unknown,
): value is ConnectorAuthMethodId {
  return connectorAuthMethodIdSchema.safeParse(value).success;
}

function defaultPermissionSummary() {
  return {
    hasPermissions: false,
    permissionCount: 0,
    hasCategories: false,
    hasDefaultPolicyOverrides: false,
  };
}

function authCodeMethod(): PublicConnectorCatalogAuthMethodDetail {
  return {
    id: "oauth",
    label: "OAuth",
    description: "Sign in to grant access.",
    grantKind: "auth-code",
    manualFields: [],
    startOptions: [],
  };
}

function manualMethod(
  fields: PublicConnectorCatalogAuthMethodDetail["manualFields"],
): PublicConnectorCatalogAuthMethodDetail {
  return {
    id: "api-token",
    label: "API Token",
    description: "Enter API credentials.",
    grantKind: "manual",
    manualFields: fields,
    startOptions: [],
  };
}

function defaultPublicCatalogStatusItem(args: {
  readonly connectorSlug: string;
  readonly label: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly authMethods?: readonly PublicConnectorCatalogAuthMethodDetail[];
}): PublicConnectorCatalogStatusItem {
  return {
    slug: args.connectorSlug,
    label: args.label,
    description: args.description,
    icon: {
      url: `https://icons.example.test/${args.connectorSlug}.svg`,
      invertInDarkMode: false,
    },
    category: "test-connectors",
    generation: [],
    tags: [...(args.tags ?? [])],
    authMethods: [...(args.authMethods ?? [authCodeMethod()])],
    permissionSummary: defaultPermissionSummary(),
    connection: null,
    connected: false,
    connectionStatus: "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
  };
}

const tokenField = {
  id: "apiKey",
  label: "API Key",
  required: true,
  placeholder: null,
  inputType: "password",
} as const;

const defaultPublicCatalogStatus = [
  defaultPublicCatalogStatusItem({
    connectorSlug: "github",
    label: "GitHub",
    description: "Access GitHub repositories.",
    tags: ["vcs", "api"],
  }),
  defaultPublicCatalogStatusItem({
    connectorSlug: "gitlab",
    label: "GitLab",
    description: "Access GitLab repositories.",
    tags: ["vcs"],
  }),
  defaultPublicCatalogStatusItem({
    connectorSlug: "microsoft-365",
    label: "Microsoft 365",
    description: "Access Microsoft 365 collaboration tools.",
    tags: ["chat"],
  }),
  defaultPublicCatalogStatusItem({
    connectorSlug: "slack",
    label: "Slack",
    description: "Send Slack messages.",
    tags: ["chat"],
  }),
  defaultPublicCatalogStatusItem({
    connectorSlug: "chatwoot",
    label: "Chatwoot",
    description: "Manage customer conversations.",
  }),
  defaultPublicCatalogStatusItem({
    connectorSlug: "openai",
    label: "OpenAI",
    description: "Access the OpenAI API.",
    tags: ["chatgpt", "api"],
    authMethods: [manualMethod([tokenField])],
  }),
  defaultPublicCatalogStatusItem({
    connectorSlug: "stripe",
    label: "Stripe",
    description: "Manage payments through the Stripe API.",
    tags: ["api", "payments"],
    authMethods: [authCodeMethod(), manualMethod([tokenField])],
  }),
  defaultPublicCatalogStatusItem({
    connectorSlug: "zendesk",
    label: "Zendesk",
    description: "Manage support data through the Zendesk API.",
    tags: ["api", "support"],
    authMethods: [
      manualMethod([
        {
          id: "apiToken",
          label: "API Token",
          required: true,
          placeholder: null,
          inputType: "password",
        },
        {
          id: "subdomain",
          label: "Subdomain",
          required: true,
          placeholder: null,
          inputType: "text",
        },
        {
          id: "email",
          label: "Email",
          required: true,
          placeholder: null,
          inputType: "text",
        },
      ]),
    ],
  }),
] satisfies readonly PublicConnectorCatalogStatusItem[];

function defaultPublicCatalog(): PublicConnectorCatalogItem[] {
  return defaultPublicCatalogStatus.map((item) => {
    return {
      slug: item.slug,
      label: item.label,
      description: item.description,
      icon: item.icon,
      category: item.category,
      generation: [...item.generation],
      tags: [...item.tags],
      authMethods: item.authMethods.map((authMethod) => {
        return {
          id: authMethod.id,
          label: authMethod.label,
          description: authMethod.description,
          grantKind: authMethod.grantKind,
        };
      }),
      permissionSummary: item.permissionSummary,
    };
  });
}

const API_ORIGINS = [
  "http://localhost:3000",
  "https://app.okou.ai",
  "https://www.okou.ai",
] as const;

function defaultPublicCatalogList(request: Request) {
  const query = new URL(request.url).searchParams;
  if (query.get("view") !== "brief") {
    return { connectors: defaultPublicCatalog() };
  }
  const slugs = query.get("slugs")?.split(",");
  const generation = query.get("generation");
  return {
    view: "brief",
    connectors: defaultPublicCatalogStatus
      .filter((item) => {
        return (
          (!slugs || slugs.includes(item.slug)) &&
          (!generation || item.generation.includes(generation))
        );
      })
      .map((item) => {
        return {
          slug: item.slug,
          label: item.label,
          icon: item.icon,
          category: item.category,
          generation: [...item.generation],
        };
      }),
  };
}

function manualGrantAuthMethodFromBody(body: unknown): ConnectorAuthMethodId {
  if (isRecord(body) && isConnectorAuthMethodId(body.authMethod)) {
    return body.authMethod;
  }
  return "api-token";
}

function connectorManualGrantResponse(
  connectorSlug: string,
  authMethod: ConnectorAuthMethodId,
) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    slug: connectorSlug,
    authMethod,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "connected",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export const apiHandlers = [
  // GET /api/connectors - listConnectors
  http.get("http://localhost:3000/api/connectors", () => {
    return HttpResponse.json(
      {
        connectors: [],
        connectorProvidedBindings: [],
      },
      { status: 200 },
    );
  }),
  http.get("https://www.okou.ai/api/connectors", () => {
    return HttpResponse.json(
      {
        connectors: [],
        connectorProvidedBindings: [],
      },
      { status: 200 },
    );
  }),

  // GET /api/connector-catalog - list public connector catalog
  ...API_ORIGINS.map((origin) => {
    return http.get(`${origin}/api/connector-catalog`, ({ request }) => {
      return HttpResponse.json(defaultPublicCatalogList(request), {
        status: 200,
      });
    });
  }),

  // GET /api/connector-catalog/status - public catalog with connection status
  ...API_ORIGINS.map((origin) => {
    return http.get(`${origin}/api/connector-catalog/status`, () => {
      return HttpResponse.json(
        { connectors: defaultPublicCatalogStatus },
        { status: 200 },
      );
    });
  }),

  // GET /api/connector-catalog/:connectorSlug - one connector with status
  ...API_ORIGINS.map((origin) => {
    return http.get(
      `${origin}/api/connector-catalog/:connectorSlug`,
      ({ params }) => {
        const connector = defaultPublicCatalogStatus.find((item) => {
          return item.slug === params.connectorSlug;
        });
        if (!connector) {
          return HttpResponse.json(
            {
              error: {
                message: "Connector catalog item not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }
        return HttpResponse.json({ connector }, { status: 200 });
      },
    );
  }),
  http.post(
    "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
    async ({ params, request }) => {
      const body: unknown = await request.json();
      return HttpResponse.json(
        connectorManualGrantResponse(
          String(params.connectorSlug),
          manualGrantAuthMethodFromBody(body),
        ),
      );
    },
  ),
  http.post(
    "https://app.okou.ai/api/connectors/:connectorSlug/manual-grant",
    async ({ params, request }) => {
      const body: unknown = await request.json();
      return HttpResponse.json(
        connectorManualGrantResponse(
          String(params.connectorSlug),
          manualGrantAuthMethodFromBody(body),
        ),
      );
    },
  ),
  http.post(
    "https://www.okou.ai/api/connectors/:connectorSlug/manual-grant",
    async ({ params, request }) => {
      const body: unknown = await request.json();
      return HttpResponse.json(
        connectorManualGrantResponse(
          String(params.connectorSlug),
          manualGrantAuthMethodFromBody(body),
        ),
      );
    },
  ),

  // GET /api/org - getOrg
  http.get("http://localhost:3000/api/org", () => {
    return HttpResponse.json(
      {
        id: "org-default",
        slug: "user-default",
        name: "Default Workspace",
        tier: "free",
      },
      { status: 200 },
    );
  }),
];
