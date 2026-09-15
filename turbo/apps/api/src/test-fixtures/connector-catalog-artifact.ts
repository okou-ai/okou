import {
  getConnectorAuthProviderRegistrationCapabilities,
  type ConnectorAuthProviderRegistrationCapability,
} from "@okouai/connectors/auth-providers";

import type {
  ConnectorCatalogArtifact,
  ConnectorCatalogArtifactConnector,
  ConnectorCatalogAuthMethod,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";

type ManualField = Extract<
  ConnectorCatalogAuthMethod["grant"],
  { readonly kind: "manual" }
>["fields"][number];
type DeviceStartOption = Extract<
  ConnectorCatalogAuthMethod["grant"],
  { readonly kind: "device-auth" }
>["startOptions"][number];
type EnvironmentBindings = ConnectorCatalogAuthMethod["access"]["envBindings"];
type GeneratedFirewall = Extract<
  ConnectorCatalogArtifactConnector["firewall"],
  { readonly kind: "generated" }
>;
type FirewallApi = GeneratedFirewall["config"]["apis"][number];

const SECRET_PREFIX = "$secrets.";
const VARIABLE_PREFIX = "$vars.";

function secret(name: string): string {
  return `${SECRET_PREFIX}${name}`;
}

function variable(name: string): string {
  return `${VARIABLE_PREFIX}${name}`;
}

function secretTemplate(name: string): string {
  return `\${{ secrets.${name} }}`;
}

function variableTemplate(name: string): string {
  return `\${{ vars.${name} }}`;
}

function basicTemplate(variableName: string, secretName: string): string {
  return ["$", `{{ basic(vars.${variableName}, secrets.${secretName}) }}`].join(
    "",
  );
}

function providerCapability(
  connectorSlug: string,
  authMethodId: string,
): ConnectorAuthProviderRegistrationCapability {
  const capability = getConnectorAuthProviderRegistrationCapabilities().find(
    (candidate) => {
      return (
        candidate.connectorSlug === connectorSlug &&
        candidate.authMethodId === authMethodId
      );
    },
  );
  if (capability === undefined) {
    throw new Error(
      `Missing test provider capability for ${connectorSlug}:${authMethodId}`,
    );
  }
  return capability;
}

function selectValueRefs(
  names: readonly string[],
  values: Readonly<Record<string, string>>,
  methodRef: string,
): Record<string, string> {
  return Object.fromEntries(
    names.map((name) => {
      const valueRef = values[name];
      if (valueRef === undefined) {
        throw new Error(`Missing ${methodRef} test value ref for ${name}`);
      }
      return [name, valueRef];
    }),
  );
}

function storageFromValueRefs(
  values: Readonly<Record<string, string>>,
  version = 1,
): ConnectorCatalogAuthMethod["storage"] {
  const secrets = new Set<string>();
  const variables = new Set<string>();
  for (const valueRef of Object.values(values)) {
    if (valueRef.startsWith(SECRET_PREFIX)) {
      secrets.add(valueRef.slice(SECRET_PREFIX.length));
    } else if (valueRef.startsWith(VARIABLE_PREFIX)) {
      variables.add(valueRef.slice(VARIABLE_PREFIX.length));
    } else {
      throw new Error(`Invalid test connector value ref: ${valueRef}`);
    }
  }
  return { version, secrets: [...secrets], variables: [...variables] };
}

function providerClient(
  capability: ConnectorAuthProviderRegistrationCapability,
  literalClient: {
    readonly clientId?: string;
    readonly clientSecret?: string;
  },
): ConnectorCatalogAuthMethod["client"] {
  switch (capability.contract.client.kind) {
    case "none": {
      return undefined;
    }
    case "static-confidential-env": {
      return {
        clientRegistration: "static",
        clientType: "confidential",
        clientIdEnv: capability.contract.client.clientIdEnv,
        clientSecretEnv: capability.contract.client.clientSecretEnv,
      };
    }
    case "static-confidential-literal": {
      return {
        clientRegistration: "static",
        clientType: "confidential",
        clientId: literalClient.clientId ?? "fixture-confidential-client",
        clientSecret:
          literalClient.clientSecret ?? "fixture-confidential-secret",
      };
    }
    case "static-public-literal": {
      return {
        clientRegistration: "static",
        clientType: "public",
        clientId: literalClient.clientId ?? "fixture-public-client",
      };
    }
    case "dynamic-public": {
      return {
        clientRegistration: "dynamic",
        clientType: "public",
      };
    }
    case "static-public-env": {
      throw new Error("The accepted API test fixture has no public env client");
    }
  }
}

interface ProviderMethodArgs {
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly values: Readonly<Record<string, string>>;
  readonly envBindings: EnvironmentBindings;
  readonly label?: string;
  readonly description?: string | null;
  readonly visible?: boolean;
  readonly scopes?: readonly string[];
  readonly fields?: readonly ManualField[];
  readonly startOptions?: readonly DeviceStartOption[];
  readonly refreshableSecrets?: readonly string[];
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly revokePreviousOnReplace?: boolean;
  readonly storageVersion?: number;
}

function providerGrant(args: {
  readonly capability: ConnectorAuthProviderRegistrationCapability;
  readonly method: ProviderMethodArgs;
  readonly methodRef: string;
  readonly outputs: Record<string, string>;
}): ConnectorCatalogAuthMethod["grant"] {
  switch (args.capability.contract.grant.kind) {
    case "manual": {
      if (args.method.fields === undefined) {
        throw new Error(`Missing ${args.methodRef} manual fields`);
      }
      return { kind: "manual", fields: [...args.method.fields] };
    }
    case "auth-code": {
      if (args.capability.contract.grant.callbackOrigin === null) {
        throw new Error(`Missing ${args.methodRef} callback origin`);
      }
      return {
        kind: "auth-code",
        scopes: [...(args.method.scopes ?? [])],
        callbackOrigin: args.capability.contract.grant.callbackOrigin,
        outputs: args.outputs,
      };
    }
    case "openid-auth": {
      if (args.capability.contract.grant.callbackOrigin === null) {
        throw new Error(`Missing ${args.methodRef} callback origin`);
      }
      return {
        kind: "openid-auth",
        callbackOrigin: args.capability.contract.grant.callbackOrigin,
        outputs: args.outputs,
      };
    }
    case "external-code": {
      return {
        kind: "external-code",
        scopes: [...(args.method.scopes ?? [])],
        outputs: args.outputs,
      };
    }
    case "device-auth": {
      return {
        kind: "device-auth",
        scopes: [...(args.method.scopes ?? [])],
        outputs: args.outputs,
        startOptions: [...(args.method.startOptions ?? [])],
      };
    }
    case "none":
    case "managed": {
      throw new Error(`Unsupported ${args.methodRef} test grant`);
    }
  }
}

function providerAccess(args: {
  readonly capability: ConnectorAuthProviderRegistrationCapability;
  readonly method: ProviderMethodArgs;
  readonly inputs: Record<string, string>;
  readonly outputs: Record<string, string>;
}): ConnectorCatalogAuthMethod["access"] {
  const platformSecrets = args.capability.contract.access.platformSecrets;
  return args.capability.contract.access.kind === "refresh-token"
    ? {
        kind: "refresh-token",
        envBindings: args.method.envBindings,
        ...(platformSecrets.length === 0
          ? {}
          : { platformSecrets: [...platformSecrets] }),
        inputs: args.inputs,
        outputs: args.outputs,
        refreshableSecrets: [...(args.method.refreshableSecrets ?? [])],
      }
    : {
        kind: "static",
        envBindings: args.method.envBindings,
        ...(platformSecrets.length === 0
          ? {}
          : { platformSecrets: [...platformSecrets] }),
      };
}

function providerRevoke(args: {
  readonly capability: ConnectorAuthProviderRegistrationCapability;
  readonly method: ProviderMethodArgs;
  readonly inputs: Record<string, string>;
}): ConnectorCatalogAuthMethod["revoke"] {
  return args.capability.contract.revoke.kind === "token-revoke"
    ? {
        kind: "token-revoke",
        inputs: args.inputs,
        ...(args.method.revokePreviousOnReplace === undefined
          ? {}
          : {
              revokePreviousOnReplace: args.method.revokePreviousOnReplace,
            }),
      }
    : { kind: "none" };
}

function providerMethod(args: ProviderMethodArgs): ConnectorCatalogAuthMethod {
  const capability = providerCapability(args.connectorSlug, args.authMethodId);
  const methodRef = `${args.connectorSlug}:${args.authMethodId}`;
  const grantOutputs = selectValueRefs(
    capability.contract.grant.outputNames,
    args.values,
    methodRef,
  );
  const accessInputs = selectValueRefs(
    capability.contract.access.inputNames,
    args.values,
    methodRef,
  );
  const accessOutputs = selectValueRefs(
    capability.contract.access.outputNames,
    args.values,
    methodRef,
  );
  const revokeInputs = selectValueRefs(
    capability.contract.revoke.inputNames,
    args.values,
    methodRef,
  );
  const client = providerClient(capability, {
    clientId: args.clientId,
    clientSecret: args.clientSecret,
  });

  return {
    id: args.authMethodId,
    label: args.label ?? "Connect",
    description:
      args.description === undefined
        ? "Test connector authorization."
        : args.description,
    visible: args.visible ?? true,
    ...(client === undefined ? {} : { client }),
    storage: storageFromValueRefs(args.values, args.storageVersion),
    grant: providerGrant({
      capability,
      method: args,
      methodRef,
      outputs: grantOutputs,
    }),
    access: providerAccess({
      capability,
      method: args,
      inputs: accessInputs,
      outputs: accessOutputs,
    }),
    revoke: providerRevoke({
      capability,
      method: args,
      inputs: revokeInputs,
    }),
  };
}

interface ManualMethodArgs {
  readonly authMethodId?: string;
  readonly label?: string;
  readonly description?: string | null;
  readonly visible?: boolean;
  readonly fields: readonly ManualField[];
  readonly envBindings: EnvironmentBindings;
  readonly additionalSecrets?: readonly string[];
  readonly additionalVariables?: readonly string[];
}

function manualMethod(args: ManualMethodArgs): ConnectorCatalogAuthMethod {
  const secrets = new Set(args.additionalSecrets ?? []);
  const variables = new Set(args.additionalVariables ?? []);
  for (const field of args.fields) {
    (field.storage === "secret" ? secrets : variables).add(field.privateName);
  }
  return {
    id: args.authMethodId ?? "api-token",
    label: args.label ?? "API Key",
    description:
      args.description === undefined
        ? "Enter test connector credentials."
        : args.description,
    visible: args.visible ?? true,
    storage: {
      version: 1,
      secrets: [...secrets],
      variables: [...variables],
    },
    grant: { kind: "manual", fields: [...args.fields] },
    access: { kind: "static", envBindings: args.envBindings },
    revoke: { kind: "none" },
  };
}

interface StandardOauthMethodArgs {
  readonly connectorSlug: string;
  readonly prefix: string;
  readonly tokenEnvironmentNames: readonly string[];
  readonly additionalValues?: Readonly<Record<string, string>>;
  readonly scopes?: readonly string[];
  readonly label?: string;
  readonly callbackDescription?: string;
  readonly platformEnvironmentNames?: readonly string[];
  readonly storageVersion?: number;
}

function standardOauthMethod(
  args: StandardOauthMethodArgs,
): ConnectorCatalogAuthMethod {
  const accessTokenName = `${args.prefix}_ACCESS_TOKEN`;
  const refreshTokenName = `${args.prefix}_REFRESH_TOKEN`;
  const accessTokenRef = secret(accessTokenName);
  const values = {
    accessToken: accessTokenRef,
    ...args.additionalValues,
    refreshToken: secret(refreshTokenName),
  };
  return providerMethod({
    connectorSlug: args.connectorSlug,
    authMethodId: "oauth",
    values,
    envBindings: {
      ...Object.fromEntries(
        args.tokenEnvironmentNames.map((name) => {
          return [name, accessTokenRef];
        }),
      ),
      ...Object.fromEntries(
        (args.platformEnvironmentNames ?? []).map((name) => {
          return [name, secret(name)];
        }),
      ),
    },
    label: args.label ?? "OAuth",
    description:
      args.callbackDescription ?? "Sign in to the test connector provider.",
    scopes: args.scopes,
    refreshableSecrets: [accessTokenName],
    ...(args.storageVersion === undefined
      ? {}
      : { storageVersion: args.storageVersion }),
  });
}

function manualField(args: {
  readonly privateName: string;
  readonly publicId: string;
  readonly label: string;
  readonly storage: "secret" | "variable";
  readonly required?: boolean;
  readonly placeholder?: string | null;
  readonly normalize?: "host";
}): ManualField {
  return {
    privateName: args.privateName,
    publicId: args.publicId,
    label: args.label,
    required: args.required ?? true,
    placeholder: args.placeholder ?? null,
    storage: args.storage,
    ...(args.normalize === undefined ? {} : { normalize: args.normalize }),
  };
}

function selectStartOption(publicId = "mode"): DeviceStartOption {
  return {
    privateName: "mode",
    publicId,
    kind: "select",
    label: "Mode",
    required: true,
    defaultValue: "test",
    options: [
      { value: "test", label: "Test" },
      { value: "live", label: "Live" },
    ],
  };
}

function generatedFirewall(
  apis: readonly FirewallApi[],
  options: {
    readonly billable?: boolean;
    readonly defaultAllowed?: readonly string[] | null;
    readonly defaultUnknownPolicy?: "allow" | "deny" | "ask";
    readonly placeholders?: Readonly<Record<string, string>>;
  } = {},
): GeneratedFirewall {
  return {
    kind: "generated",
    billable: options.billable ?? false,
    config: {
      description: "API test connector firewall.",
      ...(options.placeholders === undefined
        ? {}
        : { placeholders: options.placeholders }),
      apis: [...apis],
    },
    categories: null,
    defaultAllowed:
      options.defaultAllowed === undefined
        ? null
        : options.defaultAllowed === null
          ? null
          : [...options.defaultAllowed],
    defaultUnknownPolicy: options.defaultUnknownPolicy ?? "allow",
  };
}

function bearerApi(
  base: string,
  tokenEnvironmentName: string,
  permissions: FirewallApi["permissions"] = [],
): FirewallApi {
  return {
    base,
    auth: {
      headers: {
        Authorization: `Bearer ${secretTemplate(tokenEnvironmentName)}`,
      },
    },
    permissions,
  };
}

interface ConnectorArgs {
  readonly connectorSlug: string;
  readonly label: string;
  readonly authMethods: readonly ConnectorCatalogAuthMethod[];
  readonly description?: string;
  readonly generation?: readonly string[];
  readonly tags?: readonly string[];
  readonly icon?: ConnectorCatalogArtifactConnector["icon"];
  readonly skill?: ConnectorCatalogArtifactConnector["skill"];
  readonly firewall?: ConnectorCatalogArtifactConnector["firewall"];
}

function connector(args: ConnectorArgs): ConnectorCatalogArtifactConnector {
  return {
    slug: args.connectorSlug,
    label: args.label,
    description:
      args.description ?? `${args.label} accepted-catalog test fixture.`,
    category: "test-connectors",
    generation: [...(args.generation ?? [])],
    tags: [...(args.tags ?? [])],
    authMethods: [...args.authMethods],
    icon:
      args.icon ??
      ({
        key: `test-fixtures/connectors/${args.connectorSlug}.svg`,
        invertInDarkMode: false,
      } satisfies ConnectorCatalogArtifactConnector["icon"]),
    skill: args.skill ?? { kind: "none" },
    firewall: args.firewall ?? { kind: "none" },
  };
}

const openAiMethod = manualMethod({
  label: "API Key",
  description: "Enter an OpenAI API key.",
  fields: [
    manualField({
      privateName: "OPENAI_TOKEN",
      publicId: "apiKey",
      label: "API Key",
      storage: "secret",
      placeholder: "sk-...",
    }),
  ],
  envBindings: { OPENAI_TOKEN: secret("OPENAI_TOKEN") },
});

const slackPermissions = [
  {
    name: "conversations:read",
    rules: ["GET /conversations.list"],
  },
  {
    name: "conversations:history",
    rules: ["GET /conversations.history"],
  },
  {
    name: "users:read",
    rules: ["GET /api/users.list"],
  },
  {
    name: "chat:write",
    rules: ["POST /chat.postMessage"],
  },
  {
    name: "files:read",
    rules: ["GET /api/files.info"],
  },
  {
    name: "files:write",
    rules: ["POST /api/files.upload"],
  },
  {
    name: "search:read",
    rules: ["GET /api/search.all"],
  },
] satisfies NonNullable<FirewallApi["permissions"]>;

const connectors = [
  connector({
    connectorSlug: "ahrefs",
    label: "Ahrefs",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "ahrefs",
        prefix: "AHREFS",
        tokenEnvironmentNames: ["AHREFS_TOKEN"],
      }),
    ],
  }),
  connector({
    connectorSlug: "airtable",
    label: "Airtable",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "airtable",
        prefix: "AIRTABLE",
        tokenEnvironmentNames: ["AIRTABLE_TOKEN"],
        scopes: [
          "data.records:read",
          "data.records:write",
          "schema.bases:read",
          "offline_access",
        ],
      }),
    ],
  }),
  connector({
    connectorSlug: "asana",
    label: "Asana",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "asana",
        prefix: "ASANA",
        tokenEnvironmentNames: ["ASANA_TOKEN"],
        scopes: ["default"],
      }),
    ],
  }),
  connector({
    connectorSlug: "aws",
    label: "AWS",
    authMethods: [
      providerMethod({
        connectorSlug: "aws",
        authMethodId: "cli",
        clientId: "arn:aws:signin:::devtools/cross-device",
        scopes: ["openid"],
        values: {
          accessKeyId: secret("AWS_ACCESS_KEY_ID"),
          dpopKey: secret("AWS_LOGIN_DPOP_KEY"),
          refreshToken: secret("AWS_LOGIN_REFRESH_TOKEN"),
          runtimeRegion: variable("AWS_REGION"),
          secretAccessKey: secret("AWS_SECRET_ACCESS_KEY"),
          sessionToken: secret("AWS_SESSION_TOKEN"),
          signinRegion: variable("AWS_SIGNIN_REGION"),
        },
        envBindings: {
          AWS_ACCESS_KEY_ID: secret("AWS_ACCESS_KEY_ID"),
          AWS_DEFAULT_REGION: variable("AWS_REGION"),
          AWS_REGION: variable("AWS_REGION"),
          AWS_SECRET_ACCESS_KEY: secret("AWS_SECRET_ACCESS_KEY"),
          AWS_SESSION_TOKEN: secret("AWS_SESSION_TOKEN"),
        },
        refreshableSecrets: [
          "AWS_ACCESS_KEY_ID",
          "AWS_SECRET_ACCESS_KEY",
          "AWS_SESSION_TOKEN",
        ],
      }),
    ],
    firewall: generatedFirewall([
      {
        base: "https://{awsHost+}.amazonaws.com",
        auth: {
          awsSigv4: {
            accessKeyId: secretTemplate("AWS_ACCESS_KEY_ID"),
            secretAccessKey: secretTemplate("AWS_SECRET_ACCESS_KEY"),
            sessionToken: secretTemplate("AWS_SESSION_TOKEN"),
          },
        },
        permissions: [],
      },
    ]),
  }),
  connector({
    connectorSlug: "base44",
    label: "Base44",
    authMethods: [
      providerMethod({
        connectorSlug: "base44",
        authMethodId: "oauth",
        clientId: "base44_cli",
        values: {
          accessToken: secret("BASE44_ACCESS_TOKEN"),
          refreshToken: secret("BASE44_REFRESH_TOKEN"),
        },
        envBindings: { BASE44_TOKEN: secret("BASE44_ACCESS_TOKEN") },
        scopes: ["apps:read", "apps:write", "offline"],
        refreshableSecrets: ["BASE44_ACCESS_TOKEN"],
      }),
    ],
  }),
  connector({
    connectorSlug: "box",
    label: "Box",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "box",
        prefix: "BOX",
        tokenEnvironmentNames: ["BOX_TOKEN"],
        scopes: ["root_readwrite"],
      }),
    ],
  }),
  connector({
    connectorSlug: "bentoml",
    label: "BentoML",
    authMethods: [
      manualMethod({
        fields: [
          manualField({
            privateName: "BENTO_CLOUD_API_KEY",
            publicId: "apiToken",
            label: "API Token",
            storage: "secret",
          }),
          manualField({
            privateName: "BENTO_CLOUD_API_ENDPOINT",
            publicId: "endpoint",
            label: "Endpoint",
            storage: "variable",
            placeholder: "https://example.test",
          }),
        ],
        envBindings: {
          BENTO_CLOUD_API_KEY: secret("BENTO_CLOUD_API_KEY"),
          BENTO_CLOUD_API_ENDPOINT: variable("BENTO_CLOUD_API_ENDPOINT"),
        },
      }),
    ],
  }),
  connector({
    connectorSlug: "cal-com",
    label: "Cal.com",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "cal-com",
        prefix: "CALCOM",
        tokenEnvironmentNames: ["CALCOM_TOKEN"],
      }),
    ],
  }),
  connector({
    connectorSlug: "calendly",
    label: "Calendly",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "calendly",
        prefix: "CALENDLY",
        tokenEnvironmentNames: ["CALENDLY_TOKEN"],
        scopes: [
          "users:read",
          "scheduled_events:read",
          "scheduled_events:write",
        ],
      }),
      manualMethod({
        fields: [
          manualField({
            privateName: "CALENDLY_TOKEN",
            publicId: "accessToken",
            label: "Personal Access Token",
            storage: "secret",
          }),
        ],
        envBindings: { CALENDLY_TOKEN: secret("CALENDLY_TOKEN") },
      }),
    ],
  }),
  connector({
    connectorSlug: "canva",
    label: "Canva",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "canva",
        prefix: "CANVA",
        tokenEnvironmentNames: ["CANVA_TOKEN"],
      }),
    ],
  }),
  connector({
    connectorSlug: "close",
    label: "Close",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "close",
        prefix: "CLOSE",
        tokenEnvironmentNames: ["CLOSE_TOKEN"],
      }),
    ],
  }),
  connector({
    connectorSlug: "cloudflare",
    label: "Cloudflare",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "cloudflare",
        prefix: "CLOUDFLARE",
        tokenEnvironmentNames: ["CLOUDFLARE_TOKEN"],
        scopes: ["dns-firewall.read", "offline_access"],
      }),
      manualMethod({
        visible: false,
        fields: [
          manualField({
            privateName: "CLOUDFLARE_TOKEN",
            publicId: "apiToken",
            label: "API Token",
            storage: "secret",
          }),
        ],
        envBindings: { CLOUDFLARE_TOKEN: secret("CLOUDFLARE_TOKEN") },
      }),
    ],
    firewall: generatedFirewall(
      [
        bearerApi("https://api.cloudflare.com", "CLOUDFLARE_TOKEN", [
          {
            name: "dns-firewall.read",
            rules: [
              "GET /client/v4/accounts/{account_id}/dns_firewall/{path+}",
            ],
          },
          {
            name: "dns-firewall.write",
            rules: [
              "POST /client/v4/accounts/{account_id}/dns_firewall/{path+}",
            ],
          },
        ]),
      ],
      {
        defaultAllowed: ["dns-firewall.read"],
        defaultUnknownPolicy: "deny",
        placeholders: { CLOUDFLARE_TOKEN: "fixture-cloudflare-token" },
      },
    ),
  }),
  connector({
    connectorSlug: "cloudinary",
    label: "Cloudinary",
    authMethods: [
      manualMethod({
        fields: [
          manualField({
            privateName: "CLOUDINARY_TOKEN",
            publicId: "apiKey",
            label: "API Key",
            storage: "secret",
          }),
          manualField({
            privateName: "CLOUDINARY_API_SECRET",
            publicId: "apiSecret",
            label: "API Secret",
            storage: "secret",
          }),
          manualField({
            privateName: "CLOUDINARY_CLOUD_NAME",
            publicId: "cloudName",
            label: "Cloud Name",
            storage: "variable",
          }),
        ],
        envBindings: {
          CLOUDINARY_TOKEN: secret("CLOUDINARY_TOKEN"),
          CLOUDINARY_API_SECRET: secret("CLOUDINARY_API_SECRET"),
          CLOUDINARY_CLOUD_NAME: variable("CLOUDINARY_CLOUD_NAME"),
        },
      }),
    ],
  }),
  connector({
    connectorSlug: "copper",
    label: "Copper",
    authMethods: [
      providerMethod({
        connectorSlug: "copper",
        authMethodId: "oauth",
        values: {
          accessToken: secret("COPPER_ACCESS_TOKEN"),
        },
        envBindings: {
          COPPER_TOKEN: secret("COPPER_ACCESS_TOKEN"),
        },
      }),
    ],
  }),
  connector({
    connectorSlug: "datadog",
    label: "Datadog",
    authMethods: [
      providerMethod({
        connectorSlug: "datadog",
        authMethodId: "oauth",
        values: {
          accessToken: secret("DATADOG_ACCESS_TOKEN"),
          domain: variable("DATADOG_DOMAIN"),
          refreshToken: secret("DATADOG_REFRESH_TOKEN"),
        },
        envBindings: {
          DATADOG_TOKEN: secret("DATADOG_ACCESS_TOKEN"),
          DATADOG_DOMAIN: variable("DATADOG_DOMAIN"),
        },
        scopes: [
          "dashboards_read",
          "events_read",
          "incident_read",
          "logs_read_index_data",
          "metrics_read",
          "monitors_read",
          "slos_read",
        ],
        refreshableSecrets: ["DATADOG_ACCESS_TOKEN"],
      }),
    ],
  }),
  connector({
    connectorSlug: "deel",
    label: "Deel",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "deel",
        prefix: "DEEL",
        tokenEnvironmentNames: ["DEEL_TOKEN"],
      }),
    ],
  }),
  connector({
    connectorSlug: "docusign",
    label: "DocuSign",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "docusign",
        prefix: "DOCUSIGN",
        tokenEnvironmentNames: ["DOCUSIGN_TOKEN"],
      }),
    ],
  }),
  connector({
    connectorSlug: "dropbox",
    label: "Dropbox",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "dropbox",
        prefix: "DROPBOX",
        tokenEnvironmentNames: ["DROPBOX_TOKEN"],
      }),
    ],
  }),
  connector({
    connectorSlug: "figma",
    label: "Figma",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "figma",
        prefix: "FIGMA",
        tokenEnvironmentNames: ["FIGMA_TOKEN"],
      }),
      manualMethod({
        fields: [
          manualField({
            privateName: "FIGMA_TOKEN",
            publicId: "accessToken",
            label: "Personal Access Token",
            storage: "secret",
          }),
        ],
        envBindings: { FIGMA_TOKEN: secret("FIGMA_TOKEN") },
      }),
    ],
    firewall: generatedFirewall(
      [
        {
          base: "https://api.figma.com",
          auth: {
            headers: { "X-Figma-Token": secretTemplate("FIGMA_TOKEN") },
          },
          permissions: [
            {
              name: "file_content:read",
              rules: ["GET /v1/files/{file_key}"],
            },
          ],
        },
      ],
      { placeholders: { FIGMA_TOKEN: "fixture-figma-token" } },
    ),
  }),
  connector({
    connectorSlug: "garmin-connect",
    label: "Garmin Connect",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "garmin-connect",
        prefix: "GARMIN_CONNECT",
        tokenEnvironmentNames: ["GARMIN_CONNECT_TOKEN"],
      }),
    ],
  }),
  connector({
    connectorSlug: "github",
    label: "GitHub",
    authMethods: [
      providerMethod({
        connectorSlug: "github",
        authMethodId: "oauth",
        values: { accessToken: secret("GITHUB_ACCESS_TOKEN") },
        envBindings: {
          GH_TOKEN: secret("GITHUB_ACCESS_TOKEN"),
          GITHUB_TOKEN: secret("GITHUB_ACCESS_TOKEN"),
        },
        scopes: ["repo", "project", "workflow"],
      }),
    ],
    firewall: generatedFirewall([
      bearerApi("https://api.github.com", "GITHUB_TOKEN"),
    ]),
  }),
  connector({
    connectorSlug: "gitlab",
    label: "GitLab",
    authMethods: [
      manualMethod({
        label: "Personal Access Token",
        fields: [
          manualField({
            privateName: "GITLAB_TOKEN",
            publicId: "accessToken",
            label: "Personal Access Token",
            storage: "secret",
          }),
          manualField({
            privateName: "GITLAB_HOST",
            publicId: "host",
            label: "GitLab Host",
            storage: "variable",
            required: false,
            placeholder: "gitlab.com",
          }),
        ],
        envBindings: {
          GITLAB_TOKEN: secret("GITLAB_TOKEN"),
          GITLAB_HOST: {
            valueRef: variable("GITLAB_HOST"),
            optional: true,
          },
        },
      }),
    ],
    firewall: generatedFirewall(
      [
        {
          base: "https://gitlab.com/api",
          auth: {
            headers: { "PRIVATE-TOKEN": secretTemplate("GITLAB_TOKEN") },
          },
          permissions: [],
        },
      ],
      { placeholders: { GITLAB_TOKEN: "fixture-gitlab-token" } },
    ),
  }),
  connector({
    connectorSlug: "gmail",
    label: "Gmail",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "gmail",
        prefix: "GMAIL",
        tokenEnvironmentNames: ["GMAIL_TOKEN"],
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      }),
    ],
    firewall: generatedFirewall(
      [
        bearerApi("https://gmail.googleapis.com/gmail", "GMAIL_TOKEN", [
          { name: "messages.read", rules: ["GET /v1/users/{userId}/messages"] },
          {
            name: "messages.write",
            rules: ["POST /v1/users/{userId}/messages/send"],
          },
        ]),
      ],
      {
        defaultAllowed: ["messages.read"],
        defaultUnknownPolicy: "deny",
      },
    ),
  }),
  connector({
    connectorSlug: "google-ads",
    label: "Google Ads",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "google-ads",
        prefix: "GOOGLE_ADS",
        tokenEnvironmentNames: ["GOOGLE_ADS_TOKEN"],
        platformEnvironmentNames: ["GOOGLE_ADS_DEVELOPER_TOKEN"],
        scopes: ["https://www.googleapis.com/auth/adwords"],
      }),
    ],
    firewall: generatedFirewall([
      {
        base: "https://googleads.googleapis.com",
        auth: {
          headers: {
            Authorization: `Bearer ${secretTemplate("GOOGLE_ADS_TOKEN")}`,
            "developer-token": secretTemplate("GOOGLE_ADS_DEVELOPER_TOKEN"),
          },
        },
        permissions: [],
      },
    ]),
  }),
  connector({
    connectorSlug: "google-analytics",
    label: "Google Analytics",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "google-analytics",
        prefix: "GOOGLE_ANALYTICS",
        tokenEnvironmentNames: ["GOOGLE_ANALYTICS_TOKEN"],
        scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
      }),
    ],
  }),
  connector({
    connectorSlug: "google-calendar",
    label: "Google Calendar",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "google-calendar",
        prefix: "GOOGLE_CALENDAR",
        tokenEnvironmentNames: ["GOOGLE_CALENDAR_TOKEN"],
      }),
    ],
    firewall: generatedFirewall([
      bearerApi("https://www.googleapis.com/calendar", "GOOGLE_CALENDAR_TOKEN"),
    ]),
  }),
  connector({
    connectorSlug: "google-drive",
    label: "Google Drive",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "google-drive",
        prefix: "GOOGLE_DRIVE",
        tokenEnvironmentNames: ["GOOGLE_DRIVE_TOKEN"],
      }),
    ],
    firewall: generatedFirewall([
      bearerApi("https://www.googleapis.com/drive", "GOOGLE_DRIVE_TOKEN"),
    ]),
  }),
  connector({
    connectorSlug: "google-forms",
    label: "Google Forms",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "google-forms",
        prefix: "GOOGLE_FORMS",
        tokenEnvironmentNames: ["GOOGLE_FORMS_TOKEN"],
        scopes: [
          "https://www.googleapis.com/auth/forms.body.readonly",
          "https://www.googleapis.com/auth/forms.responses.readonly",
        ],
      }),
    ],
    firewall: generatedFirewall(
      [
        bearerApi("https://forms.googleapis.com", "GOOGLE_FORMS_TOKEN", [
          { name: "forms.read", rules: ["GET /v1/forms/{formId}"] },
          {
            name: "responses.read",
            rules: ["GET /v1/forms/{formId}/responses"],
          },
        ]),
      ],
      {
        defaultAllowed: ["forms.read", "responses.read"],
        defaultUnknownPolicy: "deny",
      },
    ),
  }),
  connector({
    connectorSlug: "google-meet",
    label: "Google Meet",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "google-meet",
        prefix: "GOOGLE_MEET",
        tokenEnvironmentNames: ["GOOGLE_MEET_TOKEN"],
      }),
    ],
    firewall: generatedFirewall([
      bearerApi("https://meet.googleapis.com", "GOOGLE_MEET_TOKEN"),
    ]),
  }),
  connector({
    connectorSlug: "google-maps",
    label: "Google Maps",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "google-maps",
        prefix: "GOOGLE_MAPS",
        tokenEnvironmentNames: ["GOOGLE_MAPS_TOKEN"],
      }),
    ],
  }),
  connector({
    connectorSlug: "gumroad",
    label: "Gumroad",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "gumroad",
        prefix: "GUMROAD",
        tokenEnvironmentNames: ["GUMROAD_TOKEN"],
        scopes: ["view_profile", "view_sales"],
      }),
    ],
  }),
  connector({
    connectorSlug: "hubspot",
    label: "HubSpot",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "hubspot",
        prefix: "HUBSPOT",
        tokenEnvironmentNames: ["HUBSPOT_TOKEN"],
        scopes: ["oauth"],
      }),
    ],
  }),
  connector({
    connectorSlug: "insforge",
    label: "InsForge",
    authMethods: [
      manualMethod({
        fields: [
          manualField({
            privateName: "INSFORGE_API_KEY",
            publicId: "apiKey",
            label: "API Key",
            storage: "secret",
          }),
          manualField({
            privateName: "INSFORGE_DOMAIN",
            publicId: "domain",
            label: "Backend URL",
            storage: "variable",
            normalize: "host",
          }),
        ],
        envBindings: {
          INSFORGE_API_KEY: secret("INSFORGE_API_KEY"),
          INSFORGE_DOMAIN: variable("INSFORGE_DOMAIN"),
        },
      }),
    ],
  }),
  connector({
    connectorSlug: "intervals-icu",
    label: "Intervals.icu",
    authMethods: [
      providerMethod({
        connectorSlug: "intervals-icu",
        authMethodId: "oauth",
        scopes: ["ACTIVITY:READ", "WELLNESS:READ"],
        values: {
          accessToken: secret("INTERVALS_ICU_ACCESS_TOKEN"),
        },
        envBindings: {
          INTERVALS_ICU_TOKEN: secret("INTERVALS_ICU_ACCESS_TOKEN"),
        },
      }),
    ],
  }),
  connector({
    connectorSlug: "jira",
    label: "Jira",
    authMethods: [
      manualMethod({
        fields: [
          manualField({
            privateName: "JIRA_API_TOKEN",
            publicId: "apiToken",
            label: "API Token",
            storage: "secret",
          }),
          manualField({
            privateName: "JIRA_DOMAIN",
            publicId: "domain",
            label: "Jira Domain",
            storage: "variable",
            normalize: "host",
          }),
          manualField({
            privateName: "JIRA_EMAIL",
            publicId: "email",
            label: "Jira Email",
            storage: "variable",
          }),
        ],
        envBindings: {
          JIRA_API_TOKEN: secret("JIRA_API_TOKEN"),
          JIRA_DOMAIN: variable("JIRA_DOMAIN"),
          JIRA_EMAIL: variable("JIRA_EMAIL"),
        },
      }),
    ],
    firewall: generatedFirewall([
      {
        base: `https://${variableTemplate("JIRA_DOMAIN")}`,
        hostPolicy: {
          kind: "providerOwned",
          suffixes: ["atlassian.net"],
        },
        auth: {
          headers: {
            Authorization: basicTemplate("JIRA_EMAIL", "JIRA_API_TOKEN"),
          },
        },
        permissions: [],
      },
    ]),
  }),
  connector({
    connectorSlug: "lark",
    label: "Lark",
    authMethods: [
      providerMethod({
        connectorSlug: "lark",
        authMethodId: "api-token",
        label: "App Credentials",
        values: {
          appId: variable("LARK_APP_ID"),
          appSecret: secret("LARK_APP_SECRET"),
          accessToken: secret("LARK_ACCESS_TOKEN"),
        },
        fields: [
          manualField({
            privateName: "LARK_APP_ID",
            publicId: "appId",
            label: "App ID",
            storage: "variable",
          }),
          manualField({
            privateName: "LARK_APP_SECRET",
            publicId: "appSecret",
            label: "App Secret",
            storage: "secret",
          }),
        ],
        envBindings: { LARK_TOKEN: secret("LARK_ACCESS_TOKEN") },
        refreshableSecrets: ["LARK_ACCESS_TOKEN"],
      }),
    ],
    firewall: generatedFirewall(
      [bearerApi("https://open.larksuite.com", "LARK_TOKEN")],
      { placeholders: { LARK_TOKEN: "fixture-lark-token" } },
    ),
  }),
  connector({
    connectorSlug: "linear",
    label: "Linear",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "linear",
        prefix: "LINEAR",
        tokenEnvironmentNames: ["LINEAR_TOKEN"],
        scopes: ["read", "write"],
      }),
    ],
  }),
  connector({
    connectorSlug: "mailchimp",
    label: "Mailchimp",
    authMethods: [
      providerMethod({
        connectorSlug: "mailchimp",
        authMethodId: "oauth",
        values: {
          accessToken: secret("MAILCHIMP_ACCESS_TOKEN"),
        },
        envBindings: {
          MAILCHIMP_TOKEN: secret("MAILCHIMP_ACCESS_TOKEN"),
        },
      }),
    ],
  }),
  connector({
    connectorSlug: "mercury",
    label: "Mercury",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "mercury",
        prefix: "MERCURY",
        tokenEnvironmentNames: ["MERCURY_TOKEN"],
        scopes: ["read", "offline_access"],
      }),
    ],
  }),
  connector({
    connectorSlug: "meta-ads",
    label: "Meta Ads",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "meta-ads",
        prefix: "META_ADS",
        tokenEnvironmentNames: ["META_ADS_TOKEN"],
        scopes: [
          "ads_management",
          "ads_read",
          "business_management",
          "pages_manage_ads",
          "pages_read_engagement",
          "pages_show_list",
          "public_profile",
        ],
      }),
    ],
  }),
  connector({
    connectorSlug: "monday",
    label: "Monday.com",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "monday",
        prefix: "MONDAY",
        tokenEnvironmentNames: ["MONDAY_TOKEN"],
        scopes: ["me:read", "boards:read", "boards:write"],
      }),
    ],
  }),
  connector({
    connectorSlug: "neon",
    label: "Neon",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "neon",
        prefix: "NEON",
        tokenEnvironmentNames: ["NEON_TOKEN"],
      }),
      manualMethod({
        fields: [
          manualField({
            privateName: "NEON_TOKEN",
            publicId: "apiKey",
            label: "API Key",
            storage: "secret",
          }),
        ],
        envBindings: { NEON_TOKEN: secret("NEON_TOKEN") },
      }),
    ],
  }),
  connector({
    connectorSlug: "nintendo-store",
    label: "Nintendo Store",
    authMethods: [
      providerMethod({
        connectorSlug: "nintendo-store",
        authMethodId: "api",
        label: "Nintendo sign-in",
        clientId: "5c38e31cd085304b",
        scopes: ["openid", "user", "user.mii", "user.email", "user.links[].id"],
        values: {
          accessToken: secret("NINTENDO_STORE_ACCESS_TOKEN"),
          accountId: variable("NINTENDO_STORE_ACCOUNT_ID"),
          idToken: secret("NINTENDO_STORE_ID_TOKEN"),
          locale: variable("NINTENDO_STORE_LOCALE"),
          sessionToken: secret("NINTENDO_STORE_SESSION_TOKEN"),
        },
        envBindings: {
          NINTENDO_STORE_TOKEN: secret("NINTENDO_STORE_ACCESS_TOKEN"),
          NINTENDO_STORE_LOCALE: variable("NINTENDO_STORE_LOCALE"),
        },
        refreshableSecrets: ["NINTENDO_STORE_ACCESS_TOKEN"],
      }),
    ],
    skill: {
      kind: "bundled",
      storageName: "connector-skill@nintendo-store",
      versionId:
        "bd7281358f92548984805062735454a06a0a08dfe8718efb5ab99ff9944ea4bb",
      storageVersionPrefix:
        "__system__/volume/connector-skill@nintendo-store/bd7281358f92548984805062735454a06a0a08dfe8718efb5ab99ff9944ea4bb",
      size: 64,
      archiveSize: 64,
      fileCount: 1,
    },
    firewall: generatedFirewall(
      [
        bearerApi("https://api.accounts.nintendo.com", "NINTENDO_STORE_TOKEN"),
        {
          ...bearerApi(
            "https://app-api.znej.nintendo.com",
            "NINTENDO_STORE_TOKEN",
          ),
          auth: {
            headers: {
              Authorization: `Bearer ${secretTemplate("NINTENDO_STORE_TOKEN")}`,
              "gentry-locale": variableTemplate("NINTENDO_STORE_LOCALE"),
            },
          },
        },
      ],
      { defaultUnknownPolicy: "deny" },
    ),
  }),
  connector({
    connectorSlug: "nintendo-switch-parental-controls",
    label: "Nintendo Switch Parental Controls",
    authMethods: [
      providerMethod({
        connectorSlug: "nintendo-switch-parental-controls",
        authMethodId: "api",
        label: "Nintendo sign-in",
        clientId: "54789befb391a838",
        scopes: [
          "openid",
          "user",
          "user.mii",
          "moonUser:administration",
          "moonDevice:create",
          "moonOwnedDevice:administration",
          "moonParentalControlSetting",
          "moonParentalControlSetting:update",
          "moonParentalControlSettingState",
          "moonPairingState",
          "moonSmartDevice:administration",
          "moonDailySummary",
          "moonMonthlySummary",
        ],
        values: {
          accessToken: secret("NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCESS_TOKEN"),
          accountId: variable("NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_ID"),
          deviceCatalog: variable(
            "NINTENDO_SWITCH_PARENTAL_CONTROLS_DEVICE_CATALOG",
          ),
          idToken: secret("NINTENDO_SWITCH_PARENTAL_CONTROLS_ID_TOKEN"),
          language: variable("NINTENDO_SWITCH_PARENTAL_CONTROLS_LANGUAGE"),
          sessionToken: secret(
            "NINTENDO_SWITCH_PARENTAL_CONTROLS_SESSION_TOKEN",
          ),
          smartDeviceId: secret(
            "NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID",
          ),
        },
        envBindings: {
          NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_TOKEN: secret(
            "NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCESS_TOKEN",
          ),
          NINTENDO_SWITCH_PARENTAL_CONTROLS_DEVICE_CATALOG: variable(
            "NINTENDO_SWITCH_PARENTAL_CONTROLS_DEVICE_CATALOG",
          ),
          NINTENDO_SWITCH_PARENTAL_CONTROLS_LANGUAGE: variable(
            "NINTENDO_SWITCH_PARENTAL_CONTROLS_LANGUAGE",
          ),
          NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID: secret(
            "NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID",
          ),
          NINTENDO_SWITCH_PARENTAL_CONTROLS_TOKEN: secret(
            "NINTENDO_SWITCH_PARENTAL_CONTROLS_ID_TOKEN",
          ),
        },
        refreshableSecrets: [
          "NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCESS_TOKEN",
          "NINTENDO_SWITCH_PARENTAL_CONTROLS_ID_TOKEN",
        ],
        revokePreviousOnReplace: true,
      }),
    ],
    firewall: generatedFirewall(
      [
        bearerApi(
          "https://api.accounts.nintendo.com",
          "NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_TOKEN",
        ),
        bearerApi(
          "https://app.lp1.znma.srv.nintendo.net",
          "NINTENDO_SWITCH_PARENTAL_CONTROLS_TOKEN",
        ),
      ],
      { defaultUnknownPolicy: "deny" },
    ),
  }),
  connector({
    connectorSlug: "notion",
    label: "Notion",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "notion",
        prefix: "NOTION",
        tokenEnvironmentNames: ["NOTION_TOKEN"],
      }),
    ],
    firewall: generatedFirewall([
      bearerApi("https://api.notion.com", "NOTION_TOKEN", [
        {
          name: "read_content",
          description: "Read fixture content.",
          rules: ["GET /v1/pages/{page_id}"],
        },
      ]),
    ]),
  }),
  connector({
    connectorSlug: "openai",
    label: "OpenAI",
    description: "OpenAI fixture for manual connector behavior.",
    generation: ["text"],
    tags: ["llm"],
    authMethods: [openAiMethod],
    icon: {
      key: "test-fixtures/connectors/openai.svg",
      invertInDarkMode: true,
    },
  }),
  connector({
    connectorSlug: "parallel",
    label: "Parallel",
    authMethods: [
      manualMethod({
        description: null,
        fields: [
          manualField({
            privateName: "PARALLEL_API_KEY",
            publicId: "apiKey",
            label: "API Key",
            storage: "secret",
          }),
        ],
        envBindings: { PARALLEL_API_KEY: secret("PARALLEL_API_KEY") },
      }),
    ],
  }),
  connector({
    connectorSlug: "playstation",
    label: "PlayStation",
    authMethods: [
      providerMethod({
        connectorSlug: "playstation",
        authMethodId: "api",
        label: "PlayStation sign-in",
        clientId: "09515159-7237-4370-9b40-3806e67c0891",
        scopes: ["psn:mobile.v2.core", "psn:clientapp"],
        values: {
          accessToken: secret("PLAYSTATION_ACCESS_TOKEN"),
          accountId: variable("PLAYSTATION_ACCOUNT_ID"),
          idToken: secret("PLAYSTATION_ID_TOKEN"),
          onlineId: variable("PLAYSTATION_ONLINE_ID"),
          refreshToken: secret("PLAYSTATION_REFRESH_TOKEN"),
        },
        envBindings: {
          PLAYSTATION_TOKEN: secret("PLAYSTATION_ACCESS_TOKEN"),
          PLAYSTATION_ACCOUNT_ID: {
            valueRef: variable("PLAYSTATION_ACCOUNT_ID"),
            optional: true,
          },
          PLAYSTATION_ONLINE_ID: {
            valueRef: variable("PLAYSTATION_ONLINE_ID"),
            optional: true,
          },
        },
        refreshableSecrets: ["PLAYSTATION_ACCESS_TOKEN"],
      }),
    ],
  }),
  connector({
    connectorSlug: "posthog",
    label: "PostHog",
    authMethods: [
      providerMethod({
        connectorSlug: "posthog",
        authMethodId: "oauth",
        clientId: "https://app.okou.ai/connectors/posthog/metadata.json",
        values: {
          accessToken: secret("POSTHOG_ACCESS_TOKEN"),
          refreshToken: secret("POSTHOG_REFRESH_TOKEN"),
          baseUrl: variable("POSTHOG_BASE_URL"),
          region: variable("POSTHOG_REGION"),
        },
        envBindings: {
          POSTHOG_TOKEN: secret("POSTHOG_ACCESS_TOKEN"),
          POSTHOG_BASE_URL: variable("POSTHOG_BASE_URL"),
          POSTHOG_REGION: variable("POSTHOG_REGION"),
        },
        refreshableSecrets: ["POSTHOG_ACCESS_TOKEN"],
        storageVersion: 2,
      }),
    ],
  }),
  connector({
    connectorSlug: "quickbooks",
    label: "QuickBooks",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "quickbooks",
        prefix: "QUICKBOOKS",
        tokenEnvironmentNames: ["QUICKBOOKS_TOKEN"],
        additionalValues: { realmId: variable("QUICKBOOKS_REALM_ID") },
        scopes: [
          "com.intuit.quickbooks.accounting",
          "openid",
          "profile",
          "email",
        ],
      }),
    ],
  }),
  connector({
    connectorSlug: "reap",
    label: "Reap",
    authMethods: [
      manualMethod({
        fields: [
          manualField({
            privateName: "REAP_API_KEY",
            publicId: "apiKey",
            label: "API Key",
            storage: "secret",
          }),
          manualField({
            privateName: "REAP_API_BASE_URL",
            publicId: "apiBaseUrl",
            label: "API Base URL",
            storage: "variable",
          }),
        ],
        envBindings: {
          REAP_API_KEY: secret("REAP_API_KEY"),
          REAP_API_BASE_URL: variable("REAP_API_BASE_URL"),
        },
      }),
    ],
    firewall: generatedFirewall([
      {
        base: variableTemplate("REAP_API_BASE_URL"),
        hostPolicy: { kind: "publicDestination" },
        auth: {
          headers: {
            Authorization: `Bearer ${secretTemplate("REAP_API_KEY")}`,
          },
        },
        permissions: [
          { name: "read", rules: ["GET /{path+}"] },
          { name: "write", rules: ["POST /{path+}"] },
        ],
      },
    ]),
  }),
  connector({
    connectorSlug: "reddit",
    label: "Reddit",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "reddit",
        prefix: "REDDIT",
        tokenEnvironmentNames: ["REDDIT_TOKEN"],
      }),
    ],
  }),
  connector({
    connectorSlug: "runtime",
    label: "Runtime",
    authMethods: [
      manualMethod({
        fields: [
          manualField({
            privateName: "RUNTIME_API_KEY",
            publicId: "apiKey",
            label: "API Key",
            storage: "secret",
          }),
        ],
        envBindings: { RUNTIME_API_KEY: secret("RUNTIME_API_KEY") },
      }),
    ],
  }),
  connector({
    connectorSlug: "sentry",
    label: "Sentry",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "sentry",
        prefix: "SENTRY",
        tokenEnvironmentNames: ["SENTRY_TOKEN"],
        scopes: ["org:read", "project:read", "event:read"],
      }),
    ],
  }),
  connector({
    connectorSlug: "serpapi",
    label: "SerpApi",
    authMethods: [
      manualMethod({
        fields: [
          manualField({
            privateName: "SERPAPI_TOKEN",
            publicId: "apiKey",
            label: "API Key",
            storage: "secret",
          }),
        ],
        envBindings: { SERPAPI_TOKEN: secret("SERPAPI_TOKEN") },
      }),
    ],
  }),
  connector({
    connectorSlug: "slack",
    label: "Slack",
    description: "Slack fixture used for search and permission behavior.",
    authMethods: [
      providerMethod({
        connectorSlug: "slack",
        authMethodId: "oauth",
        values: { accessToken: secret("SLACK_ACCESS_TOKEN") },
        envBindings: { SLACK_TOKEN: secret("SLACK_ACCESS_TOKEN") },
        scopes: [
          "channels:read",
          "chat:write",
          "users:read",
          "files:read",
          "files:write",
        ],
      }),
    ],
    icon: {
      key: "test-fixtures/connectors/slack.svg",
      invertInDarkMode: false,
      scale: 2,
    },
    firewall: generatedFirewall(
      [bearerApi("https://slack.com/api", "SLACK_TOKEN", slackPermissions)],
      {
        defaultAllowed: ["conversations:read", "users:read", "search:read"],
        placeholders: { SLACK_TOKEN: "fixture-slack-token" },
      },
    ),
  }),
  connector({
    connectorSlug: "slock",
    label: "Slock",
    authMethods: [
      providerMethod({
        connectorSlug: "slock",
        authMethodId: "oauth",
        values: {
          accessToken: secret("SLOCK_ACCESS_TOKEN"),
          refreshToken: secret("SLOCK_REFRESH_TOKEN"),
          serverId: secret("SLOCK_SERVER_ID"),
        },
        envBindings: {
          SLOCK_TOKEN: secret("SLOCK_ACCESS_TOKEN"),
          SLOCK_SERVER_ID: secret("SLOCK_SERVER_ID"),
        },
        refreshableSecrets: ["SLOCK_ACCESS_TOKEN"],
      }),
    ],
  }),
  connector({
    connectorSlug: "spotify",
    label: "Spotify",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "spotify",
        prefix: "SPOTIFY",
        tokenEnvironmentNames: ["SPOTIFY_TOKEN"],
      }),
    ],
  }),
  connector({
    connectorSlug: "steam",
    label: "Steam",
    authMethods: [
      providerMethod({
        connectorSlug: "steam",
        authMethodId: "openid",
        label: "Steam sign-in",
        values: { steamId: variable("STEAM_ID") },
        envBindings: {
          STEAM_ID: variable("STEAM_ID"),
          STEAM_WEB_API_KEY: secret("STEAM_WEB_API_KEY"),
        },
      }),
    ],
  }),
  connector({
    connectorSlug: "strava",
    label: "Strava",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "strava",
        prefix: "STRAVA",
        tokenEnvironmentNames: ["STRAVA_TOKEN"],
        scopes: ["read", "activity:read_all", "profile:read_all"],
      }),
    ],
  }),
  connector({
    connectorSlug: "stripe",
    label: "Stripe",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "stripe",
        prefix: "STRIPE",
        tokenEnvironmentNames: ["STRIPE_TOKEN"],
        additionalValues: { livemode: variable("STRIPE_LIVEMODE") },
        scopes: [
          "charge_read",
          "charge_write",
          "checkout_session_read",
          "checkout_session_write",
          "customer_read",
          "customer_write",
          "payment_intent_read",
          "payment_intent_write",
          "payment_links_read",
          "payment_links_write",
          "plan_read",
          "plan_write",
          "product_read",
          "product_write",
          "setup_intent_read",
          "setup_intent_write",
          "subscription_read",
          "subscription_write",
          "balance_read",
          "event_read",
          "invoice_read",
          "payment_method_read",
        ],
        storageVersion: 3,
      }),
      manualMethod({
        fields: [
          manualField({
            privateName: "STRIPE_TOKEN",
            publicId: "apiKey",
            label: "API Key",
            storage: "secret",
          }),
        ],
        envBindings: { STRIPE_TOKEN: secret("STRIPE_TOKEN") },
      }),
      providerMethod({
        connectorSlug: "stripe",
        authMethodId: "cli",
        values: { token: secret("STRIPE_TOKEN") },
        envBindings: { STRIPE_TOKEN: secret("STRIPE_TOKEN") },
        startOptions: [selectStartOption()],
      }),
    ],
  }),
  connector({
    connectorSlug: "supabase",
    label: "Supabase",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "supabase",
        prefix: "SUPABASE",
        tokenEnvironmentNames: ["SUPABASE_TOKEN"],
      }),
    ],
  }),
  connector({
    connectorSlug: "test-oauth",
    label: "Test OAuth",
    authMethods: [
      providerMethod({
        connectorSlug: "test-oauth",
        authMethodId: "oauth",
        clientId: "test-oauth-client",
        clientSecret: "test-oauth-secret",
        scopes: ["read"],
        values: {
          accessToken: secret("TEST_OAUTH_ACCESS_TOKEN"),
          refreshToken: secret("TEST_OAUTH_REFRESH_TOKEN"),
          tenantId: variable("TEST_OAUTH_API_TENANT_ID"),
        },
        envBindings: {
          TEST_OAUTH_TOKEN: secret("TEST_OAUTH_ACCESS_TOKEN"),
          TEST_OAUTH_TENANT_ID: variable("TEST_OAUTH_API_TENANT_ID"),
        },
        refreshableSecrets: ["TEST_OAUTH_ACCESS_TOKEN"],
      }),
      providerMethod({
        connectorSlug: "test-oauth",
        authMethodId: "api",
        clientId: "test-oauth-client",
        clientSecret: "test-oauth-secret",
        scopes: ["read"],
        values: {
          initialAccessToken: secret("TEST_OAUTH_API_ACCESS_TOKEN"),
          initialRefreshToken: secret("TEST_OAUTH_API_REFRESH_TOKEN"),
          tenantId: variable("TEST_OAUTH_API_TENANT_ID"),
          apiRefreshToken: secret("TEST_OAUTH_API_REFRESH_TOKEN"),
          refreshedAccessToken: secret("TEST_OAUTH_API_ACCESS_TOKEN"),
          refreshedRefreshToken: secret("TEST_OAUTH_API_REFRESH_TOKEN"),
          refreshedTenantId: variable("TEST_OAUTH_API_TENANT_ID"),
          secondaryToken: secret("TEST_OAUTH_API_SECONDARY_TOKEN"),
        },
        envBindings: {
          TEST_OAUTH_TOKEN: secret("TEST_OAUTH_API_ACCESS_TOKEN"),
          TEST_OAUTH_TENANT_ID: variable("TEST_OAUTH_API_TENANT_ID"),
        },
        refreshableSecrets: ["TEST_OAUTH_API_ACCESS_TOKEN"],
      }),
      providerMethod({
        connectorSlug: "test-oauth",
        authMethodId: "api-token",
        values: {
          inputSecret: secret("TEST_OAUTH_TOKEN"),
          inputVariable: variable("TEST_OAUTH_API_TOKEN_INPUT_VAR"),
          accessToken: secret("TEST_OAUTH_API_TOKEN_ACCESS_TOKEN"),
          tenantId: variable("TEST_OAUTH_API_TENANT_ID"),
        },
        fields: [
          manualField({
            privateName: "TEST_OAUTH_TOKEN",
            publicId: "apiToken",
            label: "API Token",
            storage: "secret",
          }),
          manualField({
            privateName: "TEST_OAUTH_API_TOKEN_INPUT_VAR",
            publicId: "inputVariable",
            label: "Input Variable",
            storage: "variable",
          }),
          manualField({
            privateName: "TEST_OAUTH_API_TENANT_ID",
            publicId: "tenantId",
            label: "Tenant ID",
            storage: "variable",
          }),
        ],
        envBindings: {
          TEST_OAUTH_API_TOKEN: secret("TEST_OAUTH_API_TOKEN_ACCESS_TOKEN"),
          TEST_OAUTH_TENANT_ID: variable("TEST_OAUTH_API_TENANT_ID"),
        },
        refreshableSecrets: ["TEST_OAUTH_API_TOKEN_ACCESS_TOKEN"],
      }),
    ],
    firewall: generatedFirewall(
      [
        bearerApi(
          `https://${variableTemplate("TEST_OAUTH_TENANT_ID")}.{pr}.vm6.ai/api/test/oauth-provider`,
          "TEST_OAUTH_TOKEN",
          [{ name: "echo", rules: ["GET /echo"] }],
        ),
        bearerApi(
          "https://{pr}.vm6.ai/api/test/oauth-provider",
          "TEST_OAUTH_TOKEN",
          [{ name: "echo", rules: ["GET /echo"] }],
        ),
      ],
      { placeholders: { TEST_OAUTH_TOKEN: "fixture-test-oauth-token" } },
    ),
  }),
  connector({
    connectorSlug: "test-oauth-device",
    label: "Test OAuth Device",
    authMethods: [
      providerMethod({
        connectorSlug: "test-oauth-device",
        authMethodId: "oauth",
        clientId: "test-oauth-device-client",
        scopes: ["read"],
        values: {
          accessToken: secret("TEST_OAUTH_DEVICE_ACCESS_TOKEN"),
        },
        envBindings: {
          TEST_OAUTH_DEVICE_TOKEN: secret("TEST_OAUTH_DEVICE_ACCESS_TOKEN"),
        },
      }),
      providerMethod({
        connectorSlug: "test-oauth-device",
        authMethodId: "api",
        clientId: "test-oauth-device-api-client",
        scopes: ["read"],
        values: {
          accessToken: secret("TEST_OAUTH_DEVICE_API_ACCESS_TOKEN"),
        },
        envBindings: {
          TEST_OAUTH_DEVICE_API_TOKEN: secret(
            "TEST_OAUTH_DEVICE_API_ACCESS_TOKEN",
          ),
        },
        startOptions: [selectStartOption("environment")],
      }),
    ],
  }),
  connector({
    connectorSlug: "tiktok-ads",
    label: "TikTok Ads",
    authMethods: [
      providerMethod({
        connectorSlug: "tiktok-ads",
        authMethodId: "oauth",
        values: {
          accessToken: secret("TIKTOK_ADS_ACCESS_TOKEN"),
        },
        envBindings: {
          TIKTOK_ADS_TOKEN: secret("TIKTOK_ADS_ACCESS_TOKEN"),
        },
      }),
    ],
  }),
  connector({
    connectorSlug: "todoist",
    label: "Todoist",
    authMethods: [
      providerMethod({
        connectorSlug: "todoist",
        authMethodId: "oauth",
        scopes: ["data:read_write"],
        values: {
          accessToken: secret("TODOIST_ACCESS_TOKEN"),
        },
        envBindings: {
          TODOIST_TOKEN: secret("TODOIST_ACCESS_TOKEN"),
        },
      }),
    ],
  }),
  connector({
    connectorSlug: "vercel",
    label: "Vercel",
    authMethods: [
      providerMethod({
        connectorSlug: "vercel",
        authMethodId: "oauth",
        values: {
          accessToken: secret("VERCEL_ACCESS_TOKEN"),
        },
        envBindings: {
          VERCEL_TOKEN: secret("VERCEL_ACCESS_TOKEN"),
        },
      }),
    ],
  }),
  connector({
    connectorSlug: "webflow",
    label: "Webflow",
    authMethods: [
      providerMethod({
        connectorSlug: "webflow",
        authMethodId: "oauth",
        values: {
          accessToken: secret("WEBFLOW_ACCESS_TOKEN"),
        },
        envBindings: {
          WEBFLOW_TOKEN: secret("WEBFLOW_ACCESS_TOKEN"),
        },
      }),
    ],
  }),
  connector({
    connectorSlug: "x",
    label: "X",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "x",
        prefix: "X",
        tokenEnvironmentNames: ["X_TOKEN"],
        scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
      }),
    ],
    firewall: generatedFirewall([bearerApi("https://api.x.com", "X_TOKEN")], {
      billable: true,
      placeholders: { X_TOKEN: "fixture-x-token" },
    }),
  }),
  connector({
    connectorSlug: "xero",
    label: "Xero",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "xero",
        prefix: "XERO",
        tokenEnvironmentNames: ["XERO_TOKEN"],
        scopes: [
          "openid",
          "profile",
          "email",
          "accounting.transactions",
          "accounting.contacts.read",
          "offline_access",
        ],
      }),
    ],
  }),
  connector({
    connectorSlug: "youtube",
    label: "YouTube",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "youtube",
        prefix: "YOUTUBE",
        tokenEnvironmentNames: ["YOUTUBE_TOKEN"],
        scopes: [
          "https://www.googleapis.com/auth/youtube",
          "https://www.googleapis.com/auth/youtube.force-ssl",
          "https://www.googleapis.com/auth/youtube.readonly",
          "https://www.googleapis.com/auth/youtube.upload",
          "https://www.googleapis.com/auth/userinfo.email",
        ],
      }),
    ],
  }),
  connector({
    connectorSlug: "zendesk",
    label: "Zendesk",
    authMethods: [
      manualMethod({
        fields: [
          manualField({
            privateName: "ZENDESK_API_TOKEN",
            publicId: "apiToken",
            label: "API Token",
            storage: "secret",
          }),
          manualField({
            privateName: "ZENDESK_EMAIL",
            publicId: "email",
            label: "Email",
            storage: "variable",
          }),
          manualField({
            privateName: "ZENDESK_SUBDOMAIN",
            publicId: "subdomain",
            label: "Subdomain",
            storage: "variable",
            normalize: "host",
          }),
        ],
        envBindings: {
          ZENDESK_API_TOKEN: secret("ZENDESK_API_TOKEN"),
          ZENDESK_EMAIL: variable("ZENDESK_EMAIL"),
          ZENDESK_SUBDOMAIN: variable("ZENDESK_SUBDOMAIN"),
        },
      }),
    ],
    firewall: generatedFirewall([
      {
        base: `https://${variableTemplate("ZENDESK_SUBDOMAIN")}.zendesk.com`,
        auth: {
          headers: {
            Authorization: `Bearer ${secretTemplate("ZENDESK_API_TOKEN")}`,
          },
        },
        permissions: [],
      },
    ]),
  }),
  connector({
    connectorSlug: "zoom",
    label: "Zoom",
    authMethods: [
      standardOauthMethod({
        connectorSlug: "zoom",
        prefix: "ZOOM",
        tokenEnvironmentNames: ["ZOOM_TOKEN"],
      }),
    ],
  }),
] satisfies readonly ConnectorCatalogArtifactConnector[];

export const API_TEST_CONNECTOR_CATALOG_ARTIFACT = {
  artifactSchemaVersion: 3,
  catalogVersion: "api-test-v3",
  categoryMetadata: {
    categories: [
      {
        id: "test-connectors",
        label: "Test Connectors",
        menuLabel: "Test Connectors",
        groupId: "test",
      },
    ],
    groups: [{ id: "test", label: "Test", menuLabel: "Test" }],
  },
  connectors,
} satisfies ConnectorCatalogArtifact;
