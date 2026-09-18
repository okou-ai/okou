import type { FormEvent, ReactNode } from "react";

import { ChevronRight, Plus, Trash } from "lucide-react";
import type {
  CreateCustomConnectorBody,
  CustomConnectorResponse,
  UpdateCustomConnectorBody,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  Button,
  CopyButton,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@okouai/ui";
import { Input } from "@okouai/ui/components/ui/input";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";

import { resolveApiBaseForTarget } from "../../../../signals/api-base.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  addCustomConnectorAuthMethod$,
  closeCustomConnectorEditConfirmationDialog$,
  closeCustomConnectorDialog$,
  createCustomConnector$,
  customConnectorCreateForm$,
  customConnectorEditConfirmation$,
  openCustomConnectorEditConfirmationDialog$,
  removeCustomConnectorAuthMethod$,
  setCustomConnectorCreateField$,
  setCustomConnectorCreateKind$,
  type CustomConnectorAuthMethodType,
  type CustomConnectorCreateForm,
  updateCustomConnector$,
} from "../../../../signals/okou-page/settings/custom-connectors.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { CustomConnectorUpdateConfirm } from "./custom-connector-update-confirm.tsx";

type CreateField = Exclude<
  keyof CustomConnectorCreateForm,
  "authMethodTypes" | "kind"
>;

interface CreateFormFieldProps {
  readonly form: CustomConnectorCreateForm;
  readonly setField: (field: CreateField, value: string) => void;
}

function parsePrefixLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => {
      return line.trim();
    })
    .filter((line) => {
      return line.length > 0;
    });
}

function parseScopes(raw: string): string[] {
  return raw
    .split(/\s+/u)
    .map((scope) => {
      return scope.trim();
    })
    .filter((scope) => {
      return scope.length > 0;
    });
}

const OAUTH_AUTHORIZATION_PARAM_FIELDS = [
  {
    field: "oauthResource",
    placeholder: "https://api.provider.example",
  },
  {
    field: "oauthAudience",
    placeholder: "https://api.provider.example",
  },
  {
    field: "oauthAccessType",
    placeholder: "offline",
  },
  {
    field: "oauthPrompt",
    placeholder: "consent",
  },
] as const satisfies readonly {
  readonly field: CreateField;
  readonly placeholder: string;
}[];

function ConnectorField({
  id,
  field,
  form,
  setField,
  label,
  hint,
  placeholder,
  type,
}: CreateFormFieldProps & {
  readonly id: string;
  readonly field: CreateField;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly placeholder?: string;
  readonly type?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
        {hint !== undefined && (
          <span className="text-muted-foreground font-normal ml-1">{hint}</span>
        )}
      </label>
      <Input
        id={id}
        type={type}
        value={form[field]}
        onChange={(event) => {
          setField(field, event.target.value);
        }}
        placeholder={placeholder}
      />
    </div>
  );
}

function BaseFields({
  form,
  setField,
  editing,
  setKind,
}: CreateFormFieldProps & {
  readonly editing: boolean;
  readonly setKind: (kind: CustomConnectorResponse["kind"]) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {!editing && (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.connectors.custom.create.connectorType;
            })}
          </label>
          <Select
            value={form.kind}
            onValueChange={(value) => {
              if (value === "http" || value === "mcp") {
                setKind(value);
              }
            }}
          >
            <SelectTrigger
              aria-label={t(($) => {
                return $.connectors.custom.create.connectorType;
              })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="http">
                {t(($) => {
                  return $.connectors.custom.create.httpType;
                })}
              </SelectItem>
              <SelectItem value="mcp">
                {t(($) => {
                  return $.connectors.custom.mcpStreamableHttp;
                })}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <ConnectorField
        id="cc-display-name"
        field="displayName"
        form={form}
        setField={setField}
        label={t(($) => {
          return $.connectors.custom.create.displayName;
        })}
        placeholder="Acme API"
      />
      {form.kind === "http" ? (
        <div className="flex flex-col gap-2">
          <label
            htmlFor="cc-prefixes"
            className="text-sm font-medium text-foreground"
          >
            {t(($) => {
              return $.connectors.custom.create.prefixes;
            })}
            <span className="text-muted-foreground font-normal ml-1">
              {t(($) => {
                return $.connectors.custom.create.prefixesHint;
              })}
            </span>
          </label>
          <Textarea
            id="cc-prefixes"
            value={form.prefixesRaw}
            onChange={(event) => {
              setField("prefixesRaw", event.target.value);
            }}
            placeholder="https://api.acme.com/v1/"
            rows={3}
            className="min-h-[72px] resize-y font-mono"
          />
        </div>
      ) : (
        <ConnectorField
          id="cc-mcp-endpoint"
          field="mcpEndpoint"
          form={form}
          setField={setField}
          label={t(($) => {
            return $.connectors.custom.create.mcpEndpoint;
          })}
          hint={t(($) => {
            return $.connectors.custom.create.mcpEndpointHint;
          })}
          placeholder={t(($) => {
            return $.connectors.custom.create.mcpEndpointPlaceholder;
          })}
        />
      )}
    </>
  );
}

function ApiAuthenticationFields({
  form,
  setField,
  removable,
  editable = true,
  onRemove,
}: CreateFormFieldProps & {
  readonly removable: boolean;
  readonly editable?: boolean;
  readonly onRemove?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-border p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.connectors.custom.create.apiAuthentication;
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(($) => {
              return $.connectors.custom.create.apiAuthenticationDescription;
            })}
          </p>
        </div>
        {removable && (
          <Button
            showTooltip
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t(($) => {
              return $.connectors.custom.create.removeApiAuthentication;
            })}
            onClick={onRemove}
          >
            <Trash size={16} />
          </Button>
        )}
      </div>
      {editable ? (
        <>
          <ConnectorField
            id="cc-header-name"
            field="headerName"
            form={form}
            setField={setField}
            label={t(($) => {
              return $.connectors.custom.create.headerName;
            })}
            placeholder="Authorization"
          />
          <ConnectorField
            id="cc-header-template"
            field="headerTemplate"
            form={form}
            setField={setField}
            label={t(($) => {
              return $.connectors.custom.create.headerTemplate;
            })}
            hint={t(
              ($) => {
                return $.connectors.custom.create.headerTemplateHint;
              },
              { placeholder: "{{secret}}" },
            )}
            placeholder="Bearer {{secret}}"
          />
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.connectors.custom.create.advancedApiPreserved;
          })}
        </p>
      )}
    </div>
  );
}

function customConnectorOAuthCallbackUrl(): string {
  return new URL(
    "/connectors/custom/callback",
    resolveApiBaseForTarget("app"),
  ).toString();
}

function OAuth2ClientFields({
  form,
  setField,
  editing,
}: CreateFormFieldProps & { readonly editing: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <ConnectorField
        id="cc-oauth-client-id"
        field="oauthClientId"
        form={form}
        setField={setField}
        label={t(($) => {
          return $.connectors.custom.create.clientId;
        })}
      />
      <ConnectorField
        id="cc-oauth-client-secret"
        field="oauthClientSecret"
        form={form}
        setField={setField}
        type="password"
        label={
          editing
            ? t(($) => {
                return $.connectors.custom.create.newClientSecret;
              })
            : t(($) => {
                return $.connectors.custom.create.clientSecret;
              })
        }
        placeholder={
          editing
            ? t(($) => {
                return $.connectors.custom.create.keepClientSecretPlaceholder;
              })
            : undefined
        }
      />
      {editing && (
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.connectors.custom.create.keepClientSecret;
          })}
        </p>
      )}
    </>
  );
}

function OAuth2RedirectUrlField() {
  const { t } = useTranslation();
  const redirectUrl = customConnectorOAuthCallbackUrl();
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor="cc-oauth-callback-url"
        className="text-sm font-medium text-foreground"
      >
        {t(($) => {
          return $.connectors.custom.create.redirectUrl;
        })}
        <span className="ml-1 font-normal text-amber-600 dark:text-amber-400">
          {t(($) => {
            return $.connectors.custom.create.redirectHint;
          })}
        </span>
      </label>
      <div className="relative">
        <Input
          id="cc-oauth-callback-url"
          value={redirectUrl}
          readOnly
          className="pr-10 font-mono text-xs"
        />
        <CopyButton
          type="button"
          text={redirectUrl}
          aria-label={t(($) => {
            return $.connectors.custom.create.redirectCopy;
          })}
          className="absolute top-1/2 right-1 -translate-y-1/2 p-1.5 hover:bg-state-hover"
        />
      </div>
    </div>
  );
}

function OAuth2AdvancedFields({ form, setField }: CreateFormFieldProps) {
  const { t } = useTranslation();
  return (
    <details className="group rounded-lg border border-border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-medium text-foreground">
        <ChevronRight
          size={16}
          className="shrink-0 transition-transform group-open:rotate-90"
        />
        <span>
          {t(($) => {
            return $.connectors.custom.create.advancedSettings;
          })}
        </span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-border px-3 py-4">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground">PKCE</label>
          <Select
            value={form.oauthPkceMethod}
            onValueChange={(value) => {
              setField("oauthPkceMethod", value);
            }}
          >
            <SelectTrigger aria-label="PKCE">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                {t(($) => {
                  return $.connectors.custom.create.none;
                })}
              </SelectItem>
              <SelectItem value="S256">S256</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <div>
            <p className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.connectors.custom.create.authorizationParameters;
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(($) => {
                return $.connectors.custom.create
                  .authorizationParametersDescription;
              })}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {OAUTH_AUTHORIZATION_PARAM_FIELDS.map((parameter) => {
              return (
                <ConnectorField
                  key={parameter.field}
                  id={`cc-${parameter.field}`}
                  field={parameter.field}
                  form={form}
                  setField={setField}
                  label={
                    parameter.field === "oauthResource"
                      ? t(($) => {
                          return $.connectors.custom.create.parameters.resource;
                        })
                      : parameter.field === "oauthAudience"
                        ? t(($) => {
                            return $.connectors.custom.create.parameters
                              .audience;
                          })
                        : parameter.field === "oauthAccessType"
                          ? t(($) => {
                              return $.connectors.custom.create.parameters
                                .accessType;
                            })
                          : t(($) => {
                              return $.connectors.custom.create.parameters
                                .prompt;
                            })
                  }
                  hint={t(($) => {
                    return $.connectors.custom.create.optional;
                  })}
                  placeholder={parameter.placeholder}
                />
              );
            })}
          </div>
        </div>
      </div>
    </details>
  );
}

function OAuth2EndpointFields({ form, setField }: CreateFormFieldProps) {
  const { t } = useTranslation();
  return (
    <>
      <ConnectorField
        id="cc-oauth-authorization-url"
        field="oauthAuthorizationUrl"
        form={form}
        setField={setField}
        label={t(($) => {
          return $.connectors.custom.create.authorizationUrl;
        })}
        placeholder="https://provider.example.com/oauth/authorize"
      />
      <ConnectorField
        id="cc-oauth-token-url"
        field="oauthTokenUrl"
        form={form}
        setField={setField}
        label={t(($) => {
          return $.connectors.custom.create.tokenUrl;
        })}
        placeholder="https://provider.example.com/oauth/token"
      />
    </>
  );
}

function OAuth2AuthenticationFields({
  form,
  setField,
  editing,
  onRemove,
}: CreateFormFieldProps & {
  readonly editing: boolean;
  readonly onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-border p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.connectors.custom.create.customOauthApp;
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(($) => {
              return $.connectors.custom.create.oauthDescription;
            })}
          </p>
        </div>
        <Button
          showTooltip
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t(($) => {
            return $.connectors.custom.create.removeOauth;
          })}
          onClick={onRemove}
        >
          <Trash size={16} />
        </Button>
      </div>
      <OAuth2EndpointFields form={form} setField={setField} />
      <OAuth2ClientFields form={form} setField={setField} editing={editing} />
      <div className="flex flex-col gap-2">
        <label
          htmlFor="cc-oauth-scopes"
          className="text-sm font-medium text-foreground"
        >
          {t(($) => {
            return $.connectors.custom.create.scopes;
          })}
          <span className="text-muted-foreground font-normal ml-1">
            {t(($) => {
              return $.connectors.custom.create.scopesHint;
            })}
          </span>
        </label>
        <Textarea
          id="cc-oauth-scopes"
          value={form.oauthScopesRaw}
          onChange={(event) => {
            setField("oauthScopesRaw", event.target.value);
          }}
          placeholder={"read\nwrite"}
          rows={3}
          className="min-h-[72px] resize-y font-mono"
        />
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.connectors.custom.create.tokenEndpointAuthentication;
          })}
        </label>
        <Select
          value={form.oauthClientAuthentication}
          onValueChange={(value) => {
            setField("oauthClientAuthentication", value);
          }}
        >
          <SelectTrigger
            aria-label={t(($) => {
              return $.connectors.custom.create.tokenEndpointAuthentication;
            })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="client_secret_post">
              {t(($) => {
                return $.connectors.custom.create.secretInRequestBody;
              })}
            </SelectItem>
            <SelectItem value="client_secret_basic">
              {t(($) => {
                return $.connectors.custom.create.httpBasicAuthentication;
              })}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <OAuth2RedirectUrlField />
      <OAuth2AdvancedFields form={form} setField={setField} />
      {editing && (
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.connectors.custom.create.oauthChangesDisconnect;
          })}
        </p>
      )}
    </div>
  );
}

function NoAuthenticationFields({
  onRemove,
}: {
  readonly onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-border p-4 flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.connectors.custom.create.noAuthentication;
          })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.connectors.custom.create.noAuthenticationDescription;
          })}
        </p>
      </div>
      <Button
        showTooltip
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t(($) => {
          return $.connectors.custom.create.removeNoAuthentication;
        })}
        onClick={onRemove}
      >
        <Trash size={16} />
      </Button>
    </div>
  );
}

function AutomaticAuthenticationFields({
  onRemove,
}: {
  readonly onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-border p-4 flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.connectors.custom.create.automatic;
          })}
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            {t(($) => {
              return $.connectors.custom.create.recommended;
            })}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.connectors.custom.create.automaticDescription;
          })}
        </p>
      </div>
      <Button
        showTooltip
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t(($) => {
          return $.connectors.custom.create.removeAutomatic;
        })}
        onClick={onRemove}
      >
        <Trash size={16} />
      </Button>
    </div>
  );
}

function connectorHasSimpleApiDefinition(
  connector: CustomConnectorResponse,
): boolean {
  const field = connector.fields[0];
  const injection = connector.headerInjections[0];
  return (
    connector.authMode === "manual" &&
    connector.fields.length === 1 &&
    field?.key === "secret" &&
    field.kind === "secret" &&
    field.required &&
    connector.headerInjections.length === 1 &&
    injection?.valueTemplate.includes("{{secrets.secret}}") === true &&
    connector.queryInjections.length === 0
  );
}

function connectorHasAdvancedApiDefinition(
  connector: CustomConnectorResponse | undefined,
): boolean {
  return (
    connector?.authMode === "manual" &&
    !connectorHasSimpleApiDefinition(connector)
  );
}

interface CustomConnectorDefinitionParts {
  readonly fields: CustomConnectorResponse["fields"];
  readonly headerInjections: CustomConnectorResponse["headerInjections"];
  readonly queryInjections: CustomConnectorResponse["queryInjections"];
}

function manualDefinitionFromForm(
  form: CustomConnectorCreateForm,
  connector?: CustomConnectorResponse,
): CustomConnectorDefinitionParts {
  const preserveAdvancedDefinition =
    connector !== undefined &&
    connector.authMode === "manual" &&
    !connectorHasSimpleApiDefinition(connector);
  if (preserveAdvancedDefinition) {
    return {
      fields: connector.fields,
      headerInjections: connector.headerInjections,
      queryInjections: connector.queryInjections,
    };
  }
  return {
    fields: [
      {
        key: "secret",
        label: "Secret",
        kind: "secret",
        required: true,
        description: "API credential",
      },
    ],
    headerInjections: [
      {
        name: form.headerName.trim(),
        valueTemplate: form.headerTemplate.replaceAll(
          "{{secret}}",
          "{{secrets.secret}}",
        ),
      },
    ],
    queryInjections: [],
  };
}

function oauthDefinitionFromConnector(
  connector?: CustomConnectorResponse,
): CustomConnectorDefinitionParts {
  if (connector?.authMode === "oauth") {
    return {
      fields: connector.fields,
      headerInjections: connector.headerInjections,
      queryInjections: connector.queryInjections,
    };
  }
  return {
    fields: [],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{oauth.access_token}}",
      },
    ],
    queryInjections: [],
  };
}

function oauthAuthorizationParamsFromForm(
  form: CustomConnectorCreateForm,
  connector?: CustomConnectorResponse,
): Readonly<Record<string, string>> {
  const authorizationParams = {
    ...connector?.oauthConfig?.authorizationParams,
  };
  const formParams = [
    ["resource", form.oauthResource],
    ["audience", form.oauthAudience],
    ["access_type", form.oauthAccessType],
    ["prompt", form.oauthPrompt],
  ] as const;
  for (const [name, rawValue] of formParams) {
    const value = rawValue.trim();
    if (value) {
      authorizationParams[name] = value;
    } else {
      delete authorizationParams[name];
    }
  }
  return authorizationParams;
}

function oauthConfigFromForm(
  form: CustomConnectorCreateForm,
  connector?: CustomConnectorResponse,
): NonNullable<UpdateCustomConnectorBody["oauthConfig"]> {
  return {
    providerAdapter: connector?.oauthConfig?.providerAdapter ?? "standard",
    clientId: form.oauthClientId.trim(),
    authorizationUrl: form.oauthAuthorizationUrl.trim(),
    tokenUrl: form.oauthTokenUrl.trim(),
    tokenEndpointAuthMethod: form.oauthClientAuthentication,
    pkceMethod: form.oauthPkceMethod,
    scopes: parseScopes(form.oauthScopesRaw),
    authorizationParams: oauthAuthorizationParamsFromForm(form, connector),
    ...(form.oauthClientSecret.trim().length > 0
      ? { clientSecret: form.oauthClientSecret }
      : {}),
  };
}

interface CustomConnectorSharedDefinition extends CustomConnectorDefinitionParts {
  readonly displayName: string;
  readonly authMode: "none" | "manual" | "oauth" | "automatic";
  readonly oauthConfig?: NonNullable<UpdateCustomConnectorBody["oauthConfig"]>;
}

function noAuthDefinitionFromConnector(
  connector?: CustomConnectorResponse,
): CustomConnectorDefinitionParts {
  return connector?.authMode === "none"
    ? {
        fields: connector.fields,
        headerInjections: [],
        queryInjections: [],
      }
    : { fields: [], headerInjections: [], queryInjections: [] };
}

function sharedDefinitionFromForm(
  form: CustomConnectorCreateForm,
  connector?: CustomConnectorResponse,
): CustomConnectorSharedDefinition {
  const authMode = form.authMethodTypes.includes("none")
    ? ("none" as const)
    : form.authMethodTypes.includes("automatic")
      ? ("automatic" as const)
      : form.authMethodTypes.includes("oauth2")
        ? ("oauth" as const)
        : ("manual" as const);
  const definition =
    authMode === "none"
      ? noAuthDefinitionFromConnector(connector)
      : authMode === "automatic"
        ? { fields: [], headerInjections: [], queryInjections: [] }
        : authMode === "manual"
          ? manualDefinitionFromForm(form, connector)
          : oauthDefinitionFromConnector(connector);
  return {
    displayName: form.displayName.trim(),
    ...definition,
    authMode,
    ...(authMode === "oauth"
      ? { oauthConfig: oauthConfigFromForm(form, connector) }
      : {}),
  };
}

function buildCreateBody(
  form: CustomConnectorCreateForm,
): CreateCustomConnectorBody {
  const shared = sharedDefinitionFromForm(form);
  if (form.kind === "mcp") {
    return {
      ...shared,
      kind: "mcp",
      endpoint: form.mcpEndpoint.trim(),
      transport: "streamable-http",
      storageVersion: 1,
    };
  }
  return {
    ...shared,
    prefixTemplates: parsePrefixLines(form.prefixesRaw),
    storageVersion: 1,
  };
}

function credentialFieldContract(
  fields: UpdateCustomConnectorBody["fields"],
): readonly {
  readonly key: string;
  readonly kind: "secret" | "variable";
  readonly required: boolean;
}[] {
  return fields
    .map((field) => {
      return {
        key: field.key,
        kind: field.kind,
        required: field.required,
      };
    })
    .sort((left, right) => {
      return (
        left.key.localeCompare(right.key) || left.kind.localeCompare(right.kind)
      );
    });
}

function updateChangesCredentialContract(
  connector: CustomConnectorResponse,
  body: UpdateCustomConnectorBody,
): boolean {
  const currentAuthMode = connector.authMode;
  const nextAuthMode = body.authMode ?? "manual";
  if (
    currentAuthMode !== nextAuthMode ||
    JSON.stringify(credentialFieldContract(connector.fields)) !==
      JSON.stringify(credentialFieldContract(body.fields))
  ) {
    return true;
  }
  if (
    nextAuthMode === "automatic" &&
    connector.kind === "mcp" &&
    body.kind === "mcp"
  ) {
    return connector.endpoint !== body.endpoint;
  }
  if (nextAuthMode !== "oauth") {
    return false;
  }
  const current = connector.oauthConfig;
  const next = body.oauthConfig;
  return (
    !current ||
    !next ||
    next.clientSecret !== undefined ||
    current.providerAdapter !== next.providerAdapter ||
    current.clientId !== next.clientId ||
    current.authorizationUrl !== next.authorizationUrl ||
    current.tokenUrl !== next.tokenUrl ||
    current.tokenEndpointAuthMethod !== next.tokenEndpointAuthMethod ||
    current.pkceMethod !== next.pkceMethod ||
    JSON.stringify(current.scopes) !== JSON.stringify(next.scopes) ||
    JSON.stringify(current.authorizationParams) !==
      JSON.stringify(next.authorizationParams)
  );
}

function buildUpdateBody(
  form: CustomConnectorCreateForm,
  connector: CustomConnectorResponse,
): UpdateCustomConnectorBody {
  const shared = sharedDefinitionFromForm(form, connector);
  const body: UpdateCustomConnectorBody =
    connector.kind === "mcp"
      ? {
          ...shared,
          kind: "mcp",
          endpoint: form.mcpEndpoint.trim(),
          transport: "streamable-http",
        }
      : {
          ...shared,
          prefixTemplates: parsePrefixLines(form.prefixesRaw),
        };
  return {
    ...body,
    storageVersion: updateChangesCredentialContract(connector, body)
      ? connector.storageVersion + 1
      : connector.storageVersion,
  };
}

function updateDisconnectsOAuthConnections(
  connector: CustomConnectorResponse,
  body: UpdateCustomConnectorBody,
): boolean {
  if (connector.authMode !== "oauth") {
    return false;
  }
  if (body.authMode !== "oauth" || !body.oauthConfig) {
    return true;
  }
  const existing = connector.oauthConfig;
  return (
    body.oauthConfig.clientSecret !== undefined ||
    !existing ||
    existing.clientId !== body.oauthConfig.clientId ||
    existing.authorizationUrl !== body.oauthConfig.authorizationUrl ||
    existing.tokenUrl !== body.oauthConfig.tokenUrl ||
    existing.tokenEndpointAuthMethod !==
      body.oauthConfig.tokenEndpointAuthMethod ||
    existing.pkceMethod !== body.oauthConfig.pkceMethod ||
    existing.scopes.join("\n") !== body.oauthConfig.scopes.join("\n") ||
    JSON.stringify(existing.authorizationParams) !==
      JSON.stringify(body.oauthConfig.authorizationParams)
  );
}

function oauthCredentialsCanSubmit(
  form: CustomConnectorCreateForm,
  connector?: CustomConnectorResponse,
): boolean {
  const credentialsRequired = !connector?.oauthConfig;
  const hasClientId = form.oauthClientId.trim().length > 0;
  const hasClientSecret = form.oauthClientSecret.trim().length > 0;
  return hasClientId && (!credentialsRequired || hasClientSecret);
}

function formCanSubmit(
  form: CustomConnectorCreateForm,
  connector: CustomConnectorResponse | undefined,
): boolean {
  const connectorKind = connector?.kind ?? form.kind;
  if (
    form.displayName.trim().length === 0 ||
    (connectorKind === "http"
      ? parsePrefixLines(form.prefixesRaw).length === 0
      : form.mcpEndpoint.trim().length === 0)
  ) {
    return false;
  }
  if (form.authMethodTypes.length === 0) {
    return false;
  }
  if (form.authMethodTypes.includes("none")) {
    return true;
  }
  if (form.authMethodTypes.includes("automatic")) {
    return connectorKind === "mcp";
  }
  const advancedApiDefinition =
    connector !== undefined &&
    connector.authMode === "manual" &&
    !connectorHasSimpleApiDefinition(connector);
  if (
    form.authMethodTypes.includes("api") &&
    !advancedApiDefinition &&
    (form.headerName.trim().length === 0 ||
      !form.headerTemplate.includes("{{secret}}"))
  ) {
    return false;
  }
  if (!form.authMethodTypes.includes("oauth2")) {
    return true;
  }
  if (
    form.oauthAuthorizationUrl.trim().length === 0 ||
    form.oauthTokenUrl.trim().length === 0
  ) {
    return false;
  }
  return oauthCredentialsCanSubmit(form, connector);
}

interface AuthenticationFieldsProps extends CreateFormFieldProps {
  readonly editing: boolean;
  readonly advancedApiDefinition: boolean;
  readonly addAuthMethod: (type: CustomConnectorAuthMethodType) => void;
  readonly removeAuthMethod: (type: CustomConnectorAuthMethodType) => void;
}

function AuthenticationFields({
  form,
  setField,
  editing,
  advancedApiDefinition,
  addAuthMethod,
  removeAuthMethod,
}: AuthenticationFieldsProps) {
  const { t } = useTranslation();
  const supportedAuthMethods: readonly CustomConnectorAuthMethodType[] =
    form.kind === "mcp"
      ? ["none", "api", "automatic", "oauth2"]
      : ["none", "api", "oauth2"];
  const availableAuthMethods = supportedAuthMethods.filter((type) => {
    return !form.authMethodTypes.includes(type);
  });
  return (
    <>
      {form.authMethodTypes.includes("none") && (
        <NoAuthenticationFields
          onRemove={() => {
            removeAuthMethod("none");
          }}
        />
      )}
      {form.authMethodTypes.includes("api") && (
        <ApiAuthenticationFields
          form={form}
          setField={setField}
          removable
          editable={!advancedApiDefinition}
          onRemove={() => {
            removeAuthMethod("api");
          }}
        />
      )}
      {form.authMethodTypes.includes("automatic") && (
        <AutomaticAuthenticationFields
          onRemove={() => {
            removeAuthMethod("automatic");
          }}
        />
      )}
      {form.authMethodTypes.includes("oauth2") && (
        <OAuth2AuthenticationFields
          form={form}
          setField={setField}
          editing={editing}
          onRemove={() => {
            removeAuthMethod("oauth2");
          }}
        />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={availableAuthMethods.length === 0}
          >
            <Plus size={16} />
            {t(($) => {
              return $.connectors.custom.create.addAuthentication;
            })}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {availableAuthMethods.includes("none") && (
            <DropdownMenuItem
              onClick={() => {
                addAuthMethod("none");
              }}
            >
              {t(($) => {
                return $.connectors.custom.create.noAuthentication;
              })}
            </DropdownMenuItem>
          )}
          {availableAuthMethods.includes("api") && (
            <DropdownMenuItem
              onClick={() => {
                addAuthMethod("api");
              }}
            >
              {t(($) => {
                return $.connectors.custom.create.apiAuthentication;
              })}
            </DropdownMenuItem>
          )}
          {availableAuthMethods.includes("automatic") && (
            <DropdownMenuItem
              onClick={() => {
                addAuthMethod("automatic");
              }}
            >
              {t(($) => {
                return $.connectors.custom.create.automatic;
              })}
            </DropdownMenuItem>
          )}
          {availableAuthMethods.includes("oauth2") && (
            <DropdownMenuItem
              onClick={() => {
                addAuthMethod("oauth2");
              }}
            >
              {t(($) => {
                return $.connectors.custom.create.customOauthApp;
              })}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function CustomConnectorForm({
  form,
  setField,
  setKind,
  editing,
  advancedApiDefinition,
  addAuthMethod,
  removeAuthMethod,
  submitting,
  canSubmit,
  onSubmit,
  onCancel,
}: AuthenticationFieldsProps & {
  readonly setKind: (kind: CustomConnectorResponse["kind"]) => void;
  readonly submitting: boolean;
  readonly canSubmit: boolean;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <BaseFields
        form={form}
        setField={setField}
        setKind={setKind}
        editing={editing}
      />
      <AuthenticationFields
        form={form}
        setField={setField}
        editing={editing}
        advancedApiDefinition={advancedApiDefinition}
        addAuthMethod={addAuthMethod}
        removeAuthMethod={removeAuthMethod}
      />
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={submitting}
        >
          {t(($) => {
            return $.connectors.actions.cancel;
          })}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {submitting
            ? t(($) => {
                return editing
                  ? $.connectors.actions.savingEllipsis
                  : $.connectors.actions.creating;
              })
            : t(($) => {
                return editing
                  ? $.connectors.actions.save
                  : $.connectors.actions.create;
              })}
        </Button>
      </DialogFooter>
    </form>
  );
}

function CustomConnectorDialogTitle({
  editing,
}: {
  readonly editing: boolean;
}) {
  const { t } = useTranslation();
  return (
    <DialogTitle>
      {editing
        ? t(($) => {
            return $.connectors.custom.edit.title;
          })
        : t(($) => {
            return $.connectors.custom.create.title;
          })}
    </DialogTitle>
  );
}

export function CustomConnectorCreateDialog({
  connector,
  onCreated,
}: {
  readonly connector?: CustomConnectorResponse;
  readonly onCreated?: (connector: CustomConnectorResponse) => void;
}) {
  const { t } = useTranslation();
  const form = useGet(customConnectorCreateForm$);
  const setField = useSet(setCustomConnectorCreateField$);
  const setKind = useSet(setCustomConnectorCreateKind$);
  const addAuthMethod = useSet(addCustomConnectorAuthMethod$);
  const removeAuthMethod = useSet(removeCustomConnectorAuthMethod$);
  const openEditConfirmation = useSet(
    openCustomConnectorEditConfirmationDialog$,
  );
  const closeEditConfirmation = useSet(
    closeCustomConnectorEditConfirmationDialog$,
  );
  const closeDialog = useSet(closeCustomConnectorDialog$);
  const [createLoadable, createConnector] = useLoadableSet(
    createCustomConnector$,
  );
  const [updateLoadable, updateConnector] = useLoadableSet(
    updateCustomConnector$,
  );
  const signal = useGet(pageSignal$);
  const pendingUpdate = useGet(customConnectorEditConfirmation$);

  const editing = connector !== undefined;
  const submitting = editing
    ? updateLoadable.state === "loading"
    : createLoadable.state === "loading";
  const canSubmit = !submitting && formCanSubmit(form, connector);
  const advancedApiDefinition = connectorHasAdvancedApiDefinition(connector);

  const close = () => {
    closeDialog();
  };

  const saveUpdate = (body: UpdateCustomConnectorBody) => {
    if (!connector) {
      return;
    }
    detach(
      (async () => {
        await updateConnector(
          {
            id: connector.id,
            body,
          },
          signal,
        );
        close();
      })(),
      Reason.DomCallback,
    );
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    if (connector) {
      const body = buildUpdateBody(form, connector);
      if (updateDisconnectsOAuthConnections(connector, body)) {
        openEditConfirmation({ connector, body });
        return;
      }
      saveUpdate(body);
      return;
    }
    detach(
      (async () => {
        const created = await createConnector(buildCreateBody(form), signal);
        close();
        onCreated?.(created);
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          return !open && close();
        }}
      >
        <DialogContent
          maxWidth="2xl"
          contentClassName="overflow-y-auto"
          aria-describedby={undefined}
          closeLabel={t(($) => {
            return $.connectors.actions.close;
          })}
        >
          <DialogHeader>
            <CustomConnectorDialogTitle editing={editing} />
          </DialogHeader>
          <CustomConnectorForm
            form={form}
            setField={setField}
            setKind={setKind}
            editing={editing}
            advancedApiDefinition={advancedApiDefinition}
            addAuthMethod={addAuthMethod}
            removeAuthMethod={removeAuthMethod}
            submitting={submitting}
            canSubmit={canSubmit}
            onSubmit={onSubmit}
            onCancel={close}
          />
        </DialogContent>
      </Dialog>
      {connector && pendingUpdate?.connector.id === connector.id && (
        <CustomConnectorUpdateConfirm
          submitting={submitting}
          onCancel={closeEditConfirmation}
          onConfirm={() => {
            saveUpdate(pendingUpdate.body);
          }}
        />
      )}
    </>
  );
}
