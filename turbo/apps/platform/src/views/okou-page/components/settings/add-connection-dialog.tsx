import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Input } from "@okouai/ui/components/ui/input";
import { Button } from "@okouai/ui/components/ui/button";
import { CopyButton } from "@okouai/ui/components/ui/copy-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import type { ConnectorDeviceAuthStartOptions } from "@okouai/connectors/connector-config";
import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { FormEvent, ReactElement } from "react";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogStartOption,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type {
  PlatformConnectorAccountMutationIntent,
  PlatformConnectorCatalogStatusItem,
} from "../../../../signals/connector-domain.ts";
import {
  connectFlowConnectorSlug$,
  pollingOAuthAuthCodeConnectorSlug$,
  connectorExternalCodeState$,
  connectorOAuthDeviceAuthState$,
  connectConnectorOAuthAuthCodeAndSettle$,
  connectConnectorOAuthDeviceAuthAndSettle$,
  connectConnectorNoAuthAndSettle$,
  connectConnectorExternalCode$,
  completeConnectorExternalCodeAndSettle$,
  openConnectorExternalCodeAuthorizationPage$,
  openConnectorOAuthDeviceAuthVerificationPage$,
  clearConnectorExternalCode$,
  clearConnectorOAuthDeviceAuth$,
  connectorOAuthDeviceAuthStartOptionValuesFor$,
  setConnectorOAuthDeviceAuthStartOptionValue$,
  setConnectorExternalCodeAuthorizationCode$,
  runConnectorConnectSuccess$,
  submitManualGrant$,
  setManualGrantFormValue$,
  manualGrantFormValuesFor$,
  connectorCurrentConnectionStatus,
  connectorExpiryCountdownText,
  manualGrantInputValuesForMethod,
  type ConnectorConnectionResult,
  type ConnectorExternalCodeState,
  type ConnectorOAuthDeviceAuthState,
} from "../../../../signals/okou-page/settings/connectors.ts";
import { hasTokenInputValue } from "../../../../signals/okou-page/settings/token-input.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { ConnectorIcon } from "./connector-icons.tsx";
import { detach, onDomEventFn, Reason } from "../../../../signals/utils.ts";
import { ConnectorHelpText } from "./connector-help-text.tsx";
import { i18n } from "../../../../i18n/index.ts";
import { dismissConnectorConnectionProgress$ } from "../../../../signals/connector-connection-progress.ts";
import { ConnectorConnectionDialogBody } from "../../../components/connector-connection-dialog-body.tsx";
import type {
  ConnectorAccountConnectMode,
  ConnectorAccountMutationOptions,
} from "../../../../signals/okou-page/settings/connector-account-dialogs.ts";
import { MercuryDisclosure } from "./mercury-disclosure.tsx";

// ---------------------------------------------------------------------------
// Connected status text helper
// ---------------------------------------------------------------------------

function connectedStatusText(item: PlatformConnectorCatalogStatusItem): string {
  const connectionStatus = connectorCurrentConnectionStatus(item);
  if (connectionStatus === "reconnect-required") {
    return i18n.t(($) => {
      return $.connectors.card.connectionExpired;
    });
  }
  if (connectionStatus === "scope-mismatch") {
    return i18n.t(($) => {
      return $.connectors.card.updatePermissions;
    });
  }
  const expiryText = connectorExpiryCountdownText(item);
  if (expiryText) {
    return expiryText;
  }
  if (item.connection?.externalUsername) {
    if (item.connection.externalUsername.startsWith("arn:")) {
      return i18n.t(
        ($) => {
          return $.connectors.connectDialog.connectedAs;
        },
        { username: item.connection.externalUsername },
      );
    }
    return i18n.t(
      ($) => {
        return $.connectors.connectDialog.connectedAs;
      },
      { username: `@${item.connection.externalUsername}` },
    );
  }
  return i18n.t(($) => {
    return $.connectors.card.connected;
  });
}

type PostConnectOptions = {
  readonly authorizeVisibleAgents?: boolean;
  readonly connectorLabel?: string;
  readonly agentId?: string;
  readonly account: PlatformConnectorAccountMutationIntent;
  readonly useDefaultConnectorProjection?: boolean;
};
type BrowserAuthPostConnectOptions = PostConnectOptions & {
  readonly connectorIcon: PlatformConnectorCatalogStatusItem["icon"];
};

type SubmitManualGrantFn = (
  connectorSlug: ConnectorSlug,
  authMethod: ConnectorAuthMethodId,
  inputValues: Record<string, string>,
  options: PostConnectOptions,
  signal: AbortSignal,
) => Promise<ConnectorConnectionResult | false>;

type ConnectOAuthAuthCodeAndSettleFn = (
  connectorSlug: ConnectorSlug,
  method: PublicConnectorCatalogAuthMethodDetail,
  onSuccess: (connectionId: string | null) => void | Promise<void>,
  options: BrowserAuthPostConnectOptions,
  signal: AbortSignal,
) => Promise<void>;

type ConnectOAuthDeviceAuthAndSettleFn = (
  args: {
    readonly connectorSlug: ConnectorSlug;
    readonly authMethod: ConnectorAuthMethodId;
    readonly onSuccess: (connectionId: string | null) => void | Promise<void>;
    readonly options: PostConnectOptions;
    readonly startOptions?: ConnectorDeviceAuthStartOptions;
  },
  signal: AbortSignal,
) => Promise<void>;

type ConnectExternalCodeFn = (
  args: {
    readonly connectorSlug: ConnectorSlug;
    readonly authMethod: ConnectorAuthMethodId;
    readonly agentId?: string;
    readonly account: PlatformConnectorAccountMutationIntent;
    readonly authorizeVisibleAgents?: boolean;
  },
  signal: AbortSignal,
) => Promise<void>;

type CompleteExternalCodeAndSettleFn = (
  args: {
    readonly connectorSlug: ConnectorSlug;
    readonly authMethod: ConnectorAuthMethodId;
    readonly onSuccess: (connectionId: string | null) => void | Promise<void>;
    readonly options: PostConnectOptions;
  },
  signal: AbortSignal,
) => Promise<void>;

type ConnectNoAuthAndSettleFn = (
  args: {
    readonly connectorSlug: ConnectorSlug;
    readonly authMethod: ConnectorAuthMethodId;
    readonly onSuccess: (connectionId: string | null) => void | Promise<void>;
    readonly options: PostConnectOptions;
  },
  signal: AbortSignal,
) => Promise<void>;

type ConnectModalContentProps = {
  item: PlatformConnectorCatalogStatusItem;
  agentId?: string;
  onSuccess: (connectionId: string | null) => void | Promise<void>;
  authorizeVisibleAgentsOnConnect: boolean;
  accountOptions: ConnectorAccountMutationOptions;
  accountMode?: ConnectorAccountConnectMode;
  reconnectAuthMethod?: ConnectorAuthMethodId;
};

type ConnectMethodContentProps = ConnectModalContentProps & {
  authMethod: ConnectorAuthMethodId;
  method: PublicConnectorCatalogAuthMethodDetail;
  connectOAuthAuthCodeAndSettle: ConnectOAuthAuthCodeAndSettleFn;
  connectOAuthDeviceAuthAndSettle: ConnectOAuthDeviceAuthAndSettleFn;
  connectExternalCode: ConnectExternalCodeFn;
  completeExternalCodeAndSettle: CompleteExternalCodeAndSettleFn;
  connectNoAuthAndSettle: ConnectNoAuthAndSettleFn;
  submitManualGrant: SubmitManualGrantFn;
  externalCodeCompleting: boolean;
  manualGrantSubmitting: boolean;
  noAuthSubmitting: boolean;
};

type ConnectMethodSharedContentProps = Omit<
  ConnectMethodContentProps,
  "authMethod" | "method"
>;

type ConnectMethodContentComponent = (
  props: ConnectMethodContentProps,
) => ReactElement | null;

type ConnectMethodContentEntry = {
  authMethod: ConnectorAuthMethodId;
  method: PublicConnectorCatalogAuthMethodDetail;
  Content: ConnectMethodContentComponent;
};

function connectorOAuthDeviceAuthFlowIsActive(
  state: ConnectorOAuthDeviceAuthState,
  connectorSlug: ConnectorSlug,
): boolean {
  return (
    state.connectorSlug === connectorSlug &&
    (state.status === "starting" ||
      state.status === "pending" ||
      state.status === "polling")
  );
}

function connectorExternalCodeFlowIsActive(
  state: ConnectorExternalCodeState,
  connectorSlug: ConnectorSlug,
): boolean {
  return (
    state.connectorSlug === connectorSlug &&
    (state.status === "starting" || state.status === "pending")
  );
}

function connectorOAuthDeviceAuthStateForMethod(
  state: ConnectorOAuthDeviceAuthState,
  connectorSlug: ConnectorSlug,
  authMethod: ConnectorAuthMethodId,
): ConnectorOAuthDeviceAuthState | null {
  if (state.connectorSlug !== connectorSlug || state.status === "idle") {
    return null;
  }
  return state.authMethod === authMethod ? state : null;
}

function connectorExternalCodeStateForMethod(
  state: ConnectorExternalCodeState,
  connectorSlug: ConnectorSlug,
  authMethod: ConnectorAuthMethodId,
): ConnectorExternalCodeState | null {
  if (state.connectorSlug !== connectorSlug || state.status === "idle") {
    return null;
  }
  return state.authMethod === authMethod ? state : null;
}

// ---------------------------------------------------------------------------
// Manual grant form (shown inside connect modal)
// ---------------------------------------------------------------------------

function ManualGrantForm({
  connectorSlug,
  connectorLabel,
  authMethod,
  method,
  onSuccess,
  authorizeVisibleAgentsOnConnect,
  agentId,
  accountOptions,
  submit,
  submitting,
}: {
  connectorSlug: ConnectorSlug;
  connectorLabel: string;
  authMethod: ConnectorAuthMethodId;
  method: PublicConnectorCatalogAuthMethodDetail;
  onSuccess: (connectionId: string | null) => void | Promise<void>;
  authorizeVisibleAgentsOnConnect: boolean;
  agentId?: string;
  accountOptions: ConnectorAccountMutationOptions;
  submit: SubmitManualGrantFn;
  submitting: boolean;
}) {
  const { t } = useTranslation();
  const setFormValue = useSet(setManualGrantFormValue$);
  const pageSignal = useGet(pageSignal$);
  const manualGrantFormValuesFor = useGet(manualGrantFormValuesFor$);
  const fieldValues = manualGrantFormValuesFor(connectorSlug);

  const allFilled = method.manualFields.every((field) => {
    return !field.required || hasTokenInputValue(fieldValues[field.id]);
  });

  const handleSubmit = onDomEventFn(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!allFilled || submitting) {
        return;
      }
      const connected = await submit(
        connectorSlug,
        authMethod,
        manualGrantInputValuesForMethod(method, fieldValues),
        {
          authorizeVisibleAgents: authorizeVisibleAgentsOnConnect,
          connectorLabel,
          ...(agentId ? { agentId } : {}),
          ...accountOptions,
        },
        pageSignal,
      );
      if (!connected) {
        return;
      }
      await onSuccess(connected.connectionId);
    },
  );

  return (
    <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
      {method.description && <ConnectorHelpText text={method.description} />}
      {method.manualFields.map((fieldConfig) => {
        return (
          <div key={fieldConfig.id} className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">
              {fieldConfig.label}
            </label>
            <Input
              type={fieldConfig.inputType}
              placeholder={fieldConfig.placeholder ?? undefined}
              value={fieldValues[fieldConfig.id] ?? ""}
              onChange={(e) => {
                return setFormValue(
                  connectorSlug,
                  fieldConfig.id,
                  e.target.value,
                );
              }}
            />
          </div>
        );
      })}
      <Button
        type="submit"
        disabled={!allFilled || submitting}
        className="w-full"
      >
        {submitting
          ? t(($) => {
              return $.connectors.actions.saving;
            })
          : t(($) => {
              return $.connectors.actions.save;
            })}
      </Button>
    </form>
  );
}

function UnavailableConnectMethodsContent() {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 p-3">
      <p className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.connectors.connectDialog.unavailable.title;
        })}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {t(($) => {
          return $.connectors.connectDialog.unavailable.description;
        })}
      </p>
    </div>
  );
}

function useConnectorProgressContent(
  connectorSlug: ConnectorSlug,
  pending: {
    readonly browser: boolean;
    readonly device: boolean;
    readonly external: boolean;
  },
) {
  const pollingConnectorSlug = useGet(pollingOAuthAuthCodeConnectorSlug$);
  const deviceAuthState = useGet(connectorOAuthDeviceAuthState$);
  const externalCodeState = useGet(connectorExternalCodeState$);
  const isPolling = pollingConnectorSlug === connectorSlug;
  const settling =
    pending.browser ||
    (pending.device &&
      !connectorOAuthDeviceAuthFlowIsActive(deviceAuthState, connectorSlug)) ||
    (pending.external &&
      !connectorExternalCodeFlowIsActive(externalCodeState, connectorSlug));
  // While browser authorization is in progress, only show connecting state.
  if (isPolling) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {i18n.t(($) => {
          return $.connectors.connectDialog.progress.connecting;
        })}
      </p>
    );
  }

  if (settling) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {i18n.t(($) => {
          return $.connectors.connectDialog.progress.savingPermissions;
        })}
      </p>
    );
  }

  return null;
}

function OAuthAuthCodeConnectButton({
  item,
  method,
  onSuccess,
  authorizeVisibleAgentsOnConnect,
  agentId,
  accountOptions,
  accountMode,
  reconnectAuthMethod,
  connectOAuthAuthCodeAndSettle,
}: ConnectModalContentProps & {
  method: PublicConnectorCatalogAuthMethodDetail;
  connectOAuthAuthCodeAndSettle: ConnectOAuthAuthCodeAndSettleFn;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  return (
    <Button
      variant="outline"
      onClick={() => {
        return detach(
          connectOAuthAuthCodeAndSettle(
            item.slug,
            method,
            onSuccess,
            {
              authorizeVisibleAgents: authorizeVisibleAgentsOnConnect,
              connectorLabel: item.label,
              connectorIcon: item.icon,
              ...(agentId ? { agentId } : {}),
              ...accountOptions,
            },
            signal,
          ),
          Reason.DomCallback,
        );
      }}
      className="w-full"
    >
      {accountMode?.kind === "reconnect" || reconnectAuthMethod !== undefined
        ? t(($) => {
            return $.connectors.actions.reconnect;
          })
        : accountMode || !item.connected
          ? t(($) => {
              return $.connectors.actions.connect;
            })
          : t(($) => {
              return $.connectors.actions.authorize;
            })}
    </Button>
  );
}

function OAuthAuthCodeConnectMethodContent(props: ConnectMethodContentProps) {
  return (
    <OAuthAuthCodeConnectButton
      item={props.item}
      method={props.method}
      onSuccess={props.onSuccess}
      agentId={props.agentId}
      authorizeVisibleAgentsOnConnect={props.authorizeVisibleAgentsOnConnect}
      accountOptions={props.accountOptions}
      accountMode={props.accountMode}
      reconnectAuthMethod={props.reconnectAuthMethod}
      connectOAuthAuthCodeAndSettle={props.connectOAuthAuthCodeAndSettle}
    />
  );
}

function getOAuthDeviceAuthStatusText(
  state: Extract<
    ConnectorOAuthDeviceAuthState,
    { readonly status: "pending" | "polling" }
  >,
): string {
  if (!state.approvalOpened) {
    return i18n.t(($) => {
      return $.connectors.connectDialog.device.copyThenOpen;
    });
  }
  if (state.status === "polling") {
    return i18n.t(($) => {
      return $.connectors.connectDialog.device.checking;
    });
  }
  return i18n.t(($) => {
    return $.connectors.connectDialog.device.waiting;
  });
}

function OAuthDeviceAuthCodePanel({
  state,
  onOpenVerificationPage,
}: {
  state: Extract<
    ConnectorOAuthDeviceAuthState,
    { readonly status: "pending" | "polling" }
  >;
  onOpenVerificationPage: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.connectors.connectDialog.device.description;
        })}
      </p>
      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              {t(($) => {
                return $.connectors.connectDialog.device.verificationCode;
              })}
            </p>
            <p
              className="mt-1 break-all font-mono text-2xl font-semibold tracking-normal"
              data-testid="connector-oauth-device-code"
            >
              {state.userCode}
            </p>
          </div>
          <CopyButton
            type="button"
            text={state.userCode}
            className="-m-1 p-1.5 hover:bg-state-hover"
          />
        </div>
      </div>
      {state.errorMessage && (
        <p className="text-xs text-destructive" role="alert">
          {state.errorMessage}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={onOpenVerificationPage}
        data-testid="connector-oauth-device-open"
      >
        {t(($) => {
          return $.connectors.connectDialog.device.openPage;
        })}
      </Button>
      <p className="text-xs text-muted-foreground" role="status">
        {getOAuthDeviceAuthStatusText(state)}
      </p>
    </div>
  );
}

function defaultDeviceAuthStartOptionValues(
  startOptions: readonly PublicConnectorCatalogStartOption[],
): Record<string, string> {
  return Object.fromEntries(
    startOptions.flatMap((option) => {
      return option.defaultValue === null
        ? []
        : ([[option.id, option.defaultValue]] as const);
    }),
  );
}

function deviceAuthStartOptionValue(
  values: Record<string, string>,
  name: string,
): string | undefined {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

function selectedDeviceAuthStartOptions(
  startOptions: readonly PublicConnectorCatalogStartOption[],
  values: Record<string, string>,
): ConnectorDeviceAuthStartOptions | undefined {
  if (startOptions.length === 0) {
    return undefined;
  }
  const selectedEntries = startOptions.flatMap((option) => {
    const value =
      deviceAuthStartOptionValue(values, option.id) ??
      option.defaultValue ??
      undefined;
    return value === undefined ? [] : ([[option.id, value]] as const);
  });
  return selectedEntries.length === 0
    ? undefined
    : Object.fromEntries(selectedEntries);
}

function deviceAuthStartOptionsFilled(
  startOptions: readonly PublicConnectorCatalogStartOption[],
  values: Record<string, string>,
): boolean {
  return startOptions.every((option) => {
    return (
      !option.required ||
      Boolean(
        deviceAuthStartOptionValue(values, option.id) ?? option.defaultValue,
      )
    );
  });
}

function OAuthDeviceAuthStartOptionsForm({
  connectorSlug,
  authMethod,
  startOptions,
  values,
  setValue,
}: {
  connectorSlug: ConnectorSlug;
  authMethod: ConnectorAuthMethodId;
  startOptions: readonly PublicConnectorCatalogStartOption[];
  values: Record<string, string>;
  setValue: (name: string, value: string) => void;
}) {
  const { t } = useTranslation();
  if (startOptions.length === 0) {
    return null;
  }

  return (
    <>
      {startOptions.map((option) => {
        const inputId = `connector-device-auth-option-${connectorSlug}-${authMethod}-${option.id}`;
        return (
          <div key={option.id} className="flex flex-col gap-1.5">
            <label
              htmlFor={inputId}
              className="text-sm font-medium text-foreground"
            >
              {option.label}
            </label>
            <Select
              value={
                deviceAuthStartOptionValue(values, option.id) ??
                option.defaultValue ??
                undefined
              }
              onValueChange={(value) => {
                setValue(option.id, value);
              }}
            >
              <SelectTrigger id={inputId} className="h-9">
                <SelectValue
                  placeholder={t(
                    ($) => {
                      return $.connectors.connectDialog.device.selectOption;
                    },
                    { option: option.label },
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {option.options.map((choice) => {
                  return (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        );
      })}
    </>
  );
}

function OAuthDeviceAuthStartContent({
  connectorSlug,
  connectorLabel,
  authMethod,
  startOptions,
  values,
  message,
  starting,
  startOptionsFilled,
  setValue,
  onStart,
}: {
  connectorSlug: ConnectorSlug;
  connectorLabel: string;
  authMethod: ConnectorAuthMethodId;
  startOptions: readonly PublicConnectorCatalogStartOption[];
  values: Record<string, string>;
  message?: string;
  starting: boolean;
  startOptionsFilled: boolean;
  setValue: (name: string, value: string) => void;
  onStart: (event: unknown) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      {message ? null : (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.connectDialog.device.intro;
          })}
        </p>
      )}
      <OAuthDeviceAuthStartOptionsForm
        connectorSlug={connectorSlug}
        authMethod={authMethod}
        startOptions={startOptions}
        values={values}
        setValue={setValue}
      />
      {message ? (
        <p className="text-sm text-destructive" role="alert">
          {message}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        onClick={onStart}
        disabled={starting || !startOptionsFilled}
        className="w-full"
      >
        {starting
          ? t(($) => {
              return $.connectors.connectDialog.device.starting;
            })
          : message
            ? t(($) => {
                return $.connectors.actions.tryAgain;
              })
            : t(
                ($) => {
                  return $.connectors.connectDialog.device.connect;
                },
                { connector: connectorLabel },
              )}
      </Button>
    </div>
  );
}

function OAuthDeviceAuthConnectMethodContent(props: ConnectMethodContentProps) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const state = useGet(connectorOAuthDeviceAuthState$);
  const openVerificationPage = useSet(
    openConnectorOAuthDeviceAuthVerificationPage$,
  );
  const setStartOptionValueCommand = useSet(
    setConnectorOAuthDeviceAuthStartOptionValue$,
  );
  const startOptions =
    props.method.grantKind === "device-auth" ? props.method.startOptions : [];
  const connectorOAuthDeviceAuthStartOptionValuesFor = useGet(
    connectorOAuthDeviceAuthStartOptionValuesFor$,
  );
  const startOptionValues = connectorOAuthDeviceAuthStartOptionValuesFor(
    props.item.slug,
    props.authMethod,
  );
  const effectiveStartOptionValues = {
    ...defaultDeviceAuthStartOptionValues(startOptions),
    ...startOptionValues,
  };
  const startOptionsFilled = deviceAuthStartOptionsFilled(
    startOptions,
    effectiveStartOptionValues,
  );
  const setStartOptionValue = (name: string, value: string) => {
    setStartOptionValueCommand({
      connectorSlug: props.item.slug,
      authMethod: props.authMethod,
      name,
      value,
    });
  };
  const current = connectorOAuthDeviceAuthStateForMethod(
    state,
    props.item.slug,
    props.authMethod,
  );
  const starting = current?.status === "starting";

  const start = onDomEventFn(async () => {
    await props.connectOAuthDeviceAuthAndSettle(
      {
        connectorSlug: props.item.slug,
        authMethod: props.authMethod,
        onSuccess: props.onSuccess,
        options: {
          authorizeVisibleAgents: props.authorizeVisibleAgentsOnConnect,
          connectorLabel: props.item.label,
          ...(props.agentId ? { agentId: props.agentId } : {}),
          ...props.accountOptions,
        },
        startOptions: selectedDeviceAuthStartOptions(
          startOptions,
          effectiveStartOptionValues,
        ),
      },
      signal,
    );
  });

  if (current?.status === "starting") {
    return (
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.connectors.connectDialog.device.startingConnection;
        })}
      </p>
    );
  }

  if (current?.status === "pending" || current?.status === "polling") {
    return (
      <OAuthDeviceAuthCodePanel
        state={current}
        onOpenVerificationPage={() => {
          openVerificationPage(props.item.slug, props.authMethod);
        }}
      />
    );
  }

  if (
    current?.status === "denied" ||
    current?.status === "expired" ||
    current?.status === "error"
  ) {
    return (
      <OAuthDeviceAuthStartContent
        connectorSlug={props.item.slug}
        connectorLabel={props.item.label}
        authMethod={props.authMethod}
        startOptions={startOptions}
        values={effectiveStartOptionValues}
        message={current.message}
        starting={starting}
        startOptionsFilled={startOptionsFilled}
        setValue={setStartOptionValue}
        onStart={start}
      />
    );
  }

  return (
    <OAuthDeviceAuthStartContent
      connectorSlug={props.item.slug}
      connectorLabel={props.item.label}
      authMethod={props.authMethod}
      startOptions={startOptions}
      values={effectiveStartOptionValues}
      starting={starting}
      startOptionsFilled={startOptionsFilled}
      setValue={setStartOptionValue}
      onStart={start}
    />
  );
}

type PendingConnectorExternalCodeState = Extract<
  ConnectorExternalCodeState,
  { readonly status: "pending" }
>;
type ExternalCodeButtonHandler = (event: unknown) => void;
type ExternalCodeSubmitHandler = (event: FormEvent<HTMLFormElement>) => void;

function ExternalCodeStartContent({
  connectorLabel,
  method,
  current,
  starting,
  onStart,
}: {
  connectorLabel: string;
  method: PublicConnectorCatalogAuthMethodDetail;
  current: ConnectorExternalCodeState | null;
  starting: boolean;
  onStart: ExternalCodeButtonHandler;
}) {
  const { t } = useTranslation();
  const terminalMessage =
    current?.status === "expired" || current?.status === "error"
      ? current.message
      : null;
  return (
    <div className="flex flex-col gap-3">
      {method.description && <ConnectorHelpText text={method.description} />}
      {terminalMessage ? (
        <p className="text-sm text-destructive" role="alert">
          {terminalMessage}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        onClick={onStart}
        disabled={starting}
        className="w-full"
      >
        {starting
          ? t(($) => {
              return $.connectors.connectDialog.device.starting;
            })
          : t(
              ($) => {
                return $.connectors.connectDialog.external.start;
              },
              { connector: connectorLabel },
            )}
      </Button>
    </div>
  );
}

function ExternalCodePendingContent({
  connectorLabel,
  method,
  current,
  completing,
  onOpen,
  onCodeChange,
  onComplete,
}: {
  connectorLabel: string;
  method: PublicConnectorCatalogAuthMethodDetail;
  current: PendingConnectorExternalCodeState;
  completing: boolean;
  onOpen: ExternalCodeButtonHandler;
  onCodeChange: (code: string) => void;
  onComplete: ExternalCodeSubmitHandler;
}) {
  const { t } = useTranslation();
  return (
    <form className="flex flex-col gap-3" onSubmit={onComplete}>
      {method.description && <ConnectorHelpText text={method.description} />}
      {!method.description && (
        <p className="text-sm text-muted-foreground">
          {t(
            ($) => {
              return $.connectors.connectDialog.external.description;
            },
            { connector: connectorLabel },
          )}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-w-0 flex-1"
          onClick={onOpen}
        >
          {t(
            ($) => {
              return $.connectors.connectDialog.external.open;
            },
            { connector: connectorLabel },
          )}
        </Button>
        <CopyButton
          type="button"
          text={current.authorizationUrl}
          className="p-2 hover:bg-state-hover"
        />
      </div>
      <label className="sr-only" htmlFor="connector-external-code-input">
        {t(($) => {
          return $.connectors.connectDialog.external.code;
        })}
      </label>
      <Input
        id="connector-external-code-input"
        value={current.code}
        onChange={(event) => {
          onCodeChange(event.target.value);
        }}
        placeholder={t(($) => {
          return $.connectors.connectDialog.external.code;
        })}
        autoComplete="one-time-code"
        data-testid="connector-external-code-input"
      />
      {current.errorMessage && (
        <p className="text-xs text-destructive" role="alert">
          {current.errorMessage}
        </p>
      )}
      <Button
        type="submit"
        disabled={completing || current.code.trim().length === 0}
        className="w-full"
        data-testid="connector-external-code-complete"
      >
        {completing
          ? t(($) => {
              return $.connectors.actions.connecting;
            })
          : t(($) => {
              return $.connectors.connectDialog.external.complete;
            })}
      </Button>
    </form>
  );
}

function ExternalCodeConnectMethodContent(props: ConnectMethodContentProps) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const state = useGet(connectorExternalCodeState$);
  const setCode = useSet(setConnectorExternalCodeAuthorizationCode$);
  const openAuthorizationPage = useSet(
    openConnectorExternalCodeAuthorizationPage$,
  );
  const current = connectorExternalCodeStateForMethod(
    state,
    props.item.slug,
    props.authMethod,
  );
  const starting = current?.status === "starting";

  const start = onDomEventFn(async () => {
    await props.connectExternalCode(
      {
        connectorSlug: props.item.slug,
        authMethod: props.authMethod,
        ...(props.agentId ? { agentId: props.agentId } : {}),
        ...props.accountOptions,
        authorizeVisibleAgents: props.authorizeVisibleAgentsOnConnect,
      },
      signal,
    );
  });

  const complete = onDomEventFn(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await props.completeExternalCodeAndSettle(
      {
        connectorSlug: props.item.slug,
        authMethod: props.authMethod,
        onSuccess: props.onSuccess,
        options: {
          authorizeVisibleAgents: props.authorizeVisibleAgentsOnConnect,
          connectorLabel: props.item.label,
          ...(props.agentId ? { agentId: props.agentId } : {}),
          ...props.accountOptions,
        },
      },
      signal,
    );
  });

  if (starting) {
    return (
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.connectors.connectDialog.device.startingConnection;
        })}
      </p>
    );
  }

  if (current?.status === "pending") {
    return (
      <ExternalCodePendingContent
        connectorLabel={props.item.label}
        method={props.method}
        current={current}
        completing={props.externalCodeCompleting}
        onOpen={() => {
          openAuthorizationPage(props.item.slug, props.authMethod);
        }}
        onCodeChange={(code) => {
          setCode({
            connectorSlug: props.item.slug,
            authMethod: props.authMethod,
            code,
          });
        }}
        onComplete={complete}
      />
    );
  }

  return (
    <ExternalCodeStartContent
      connectorLabel={props.item.label}
      method={props.method}
      current={current}
      starting={starting}
      onStart={start}
    />
  );
}

function ManualGrantConnectMethodContent(props: ConnectMethodContentProps) {
  if (props.method.grantKind !== "manual") {
    return null;
  }
  return (
    <ManualGrantForm
      connectorSlug={props.item.slug}
      connectorLabel={props.item.label}
      authMethod={props.authMethod}
      method={props.method}
      onSuccess={props.onSuccess}
      authorizeVisibleAgentsOnConnect={props.authorizeVisibleAgentsOnConnect}
      agentId={props.agentId}
      accountOptions={props.accountOptions}
      submit={props.submitManualGrant}
      submitting={props.manualGrantSubmitting}
    />
  );
}

function NoAuthConnectMethodContent(props: ConnectMethodContentProps) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const enable = onDomEventFn(async () => {
    await props.connectNoAuthAndSettle(
      {
        connectorSlug: props.item.slug,
        authMethod: props.authMethod,
        onSuccess: props.onSuccess,
        options: {
          authorizeVisibleAgents: props.authorizeVisibleAgentsOnConnect,
          connectorLabel: props.item.label,
          ...(props.agentId ? { agentId: props.agentId } : {}),
          ...props.accountOptions,
        },
      },
      signal,
    );
  });

  return (
    <div className="flex flex-col gap-3">
      {props.method.description && (
        <ConnectorHelpText text={props.method.description} />
      )}
      <Button
        type="button"
        variant="outline"
        onClick={enable}
        disabled={props.noAuthSubmitting}
        className="w-full"
      >
        {props.noAuthSubmitting
          ? t(($) => {
              return $.connectors.connectDialog.noAuth.enabling;
            })
          : t(
              ($) => {
                return $.connectors.connectDialog.noAuth.enable;
              },
              { connector: props.item.label },
            )}
      </Button>
    </div>
  );
}

function getConnectMethodContentComponent(
  method: PublicConnectorCatalogAuthMethodDetail,
): ConnectMethodContentComponent | null {
  switch (method.grantKind) {
    case "auth-code": {
      return OAuthAuthCodeConnectMethodContent;
    }
    case "openid-auth": {
      return OAuthAuthCodeConnectMethodContent;
    }
    case "device-auth": {
      return OAuthDeviceAuthConnectMethodContent;
    }
    case "external-code": {
      return ExternalCodeConnectMethodContent;
    }
    case "manual": {
      return ManualGrantConnectMethodContent;
    }
    case "none": {
      return NoAuthConnectMethodContent;
    }
    case "managed": {
      return null;
    }
  }
}

function getConnectEntries(
  item: PlatformConnectorCatalogStatusItem,
  accountMode: ConnectorAccountConnectMode | undefined,
  reconnectAuthMethod: ConnectorAuthMethodId | undefined,
): ConnectMethodContentEntry[] {
  const requiredAuthMethod =
    accountMode?.kind === "reconnect"
      ? accountMode.authMethod
      : reconnectAuthMethod;
  return item.authMethods.flatMap((method) => {
    if (requiredAuthMethod !== undefined && method.id !== requiredAuthMethod) {
      return [];
    }
    const authMethod = method.id;
    const Content = getConnectMethodContentComponent(method);
    return Content ? [{ authMethod, method, Content }] : [];
  });
}

function AuthMethodDivider() {
  const { t } = useTranslation();
  return (
    <div className="relative py-1">
      <div className="absolute inset-0 flex items-center">
        <span className="w-full border-t border-t-gray-400" />
      </div>
      <div className="relative flex justify-center text-xs">
        <span className="bg-background px-2 text-muted-foreground">
          {t(($) => {
            return $.connectors.connectDialog.or;
          })}
        </span>
      </div>
    </div>
  );
}

function ConnectMethodHeading({
  method,
  show,
}: {
  method: PublicConnectorCatalogAuthMethodDetail;
  show: boolean;
}) {
  if (!show) {
    return null;
  }

  return (
    <h3 className="text-sm font-medium text-foreground">{method.label}</h3>
  );
}

function ConnectMethodsContent({
  entries,
  availableAuthMethodCount,
  props,
}: {
  entries: readonly ConnectMethodContentEntry[];
  availableAuthMethodCount: number;
  props: ConnectMethodSharedContentProps;
}) {
  const { t } = useTranslation();
  if (availableAuthMethodCount === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.connectors.connectDialog.noMethod;
        })}
      </p>
    );
  }

  if (entries.length === 0) {
    return <UnavailableConnectMethodsContent />;
  }

  const showMethodHeadings = entries.length > 1;
  return (
    <>
      {entries.map(({ authMethod, method, Content }, index) => {
        return (
          <div
            key={`${props.item.slug}:${authMethod}`}
            className="flex flex-col gap-3"
          >
            {index > 0 && <AuthMethodDivider />}
            <ConnectMethodHeading method={method} show={showMethodHeadings} />
            <Content {...props} authMethod={authMethod} method={method} />
          </div>
        );
      })}
    </>
  );
}

function StandardConnectMethodsContent({
  item,
  agentId,
  onSuccess,
  authorizeVisibleAgentsOnConnect,
  accountOptions,
  accountMode,
  reconnectAuthMethod,
  connectOAuthAuthCodeAndSettle,
  connectOAuthDeviceAuthAndSettle,
  connectExternalCode,
  completeExternalCodeAndSettle,
  connectNoAuthAndSettle,
  submitManualGrant,
  externalCodeCompleting,
  manualGrantSubmitting,
  noAuthSubmitting,
  entries,
}: ConnectModalContentProps & {
  connectOAuthAuthCodeAndSettle: ConnectOAuthAuthCodeAndSettleFn;
  connectOAuthDeviceAuthAndSettle: ConnectOAuthDeviceAuthAndSettleFn;
  connectExternalCode: ConnectExternalCodeFn;
  completeExternalCodeAndSettle: CompleteExternalCodeAndSettleFn;
  connectNoAuthAndSettle: ConnectNoAuthAndSettleFn;
  submitManualGrant: SubmitManualGrantFn;
  externalCodeCompleting: boolean;
  manualGrantSubmitting: boolean;
  noAuthSubmitting: boolean;
  entries: readonly ConnectMethodContentEntry[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <ConnectMethodsContent
        entries={entries}
        availableAuthMethodCount={item.authMethods.length}
        props={{
          item,
          agentId,
          onSuccess,
          authorizeVisibleAgentsOnConnect,
          accountOptions,
          accountMode,
          reconnectAuthMethod,
          connectOAuthAuthCodeAndSettle,
          connectOAuthDeviceAuthAndSettle,
          connectExternalCode,
          completeExternalCodeAndSettle,
          connectNoAuthAndSettle,
          submitManualGrant,
          externalCodeCompleting,
          manualGrantSubmitting,
          noAuthSubmitting,
        }}
      />
    </div>
  );
}

function ConnectModalContent({
  item,
  agentId,
  onSuccess,
  authorizeVisibleAgentsOnConnect,
  accountOptions,
  accountMode,
  reconnectAuthMethod,
}: ConnectModalContentProps) {
  const [settleLoadable, connectOAuthAuthCodeAndSettleCommand] = useLoadableSet(
    connectConnectorOAuthAuthCodeAndSettle$,
  );
  const [deviceAuthLoadable, connectOAuthDeviceAuthAndSettle] = useLoadableSet(
    connectConnectorOAuthDeviceAuthAndSettle$,
  );
  const [, connectExternalCodeCommand] = useLoadableSet(
    connectConnectorExternalCode$,
  );
  const [completeExternalCodeLoadable, completeExternalCodeAndSettleCommand] =
    useLoadableSet(completeConnectorExternalCodeAndSettle$);
  const [manualGrantLoadable, submitManualGrantCommand] =
    useLoadableSet(submitManualGrant$);
  const [noAuthLoadable, connectNoAuthAndSettleCommand] = useLoadableSet(
    connectConnectorNoAuthAndSettle$,
  );
  const submitManualGrant: SubmitManualGrantFn = async (
    connectorSlug,
    authMethod,
    inputValues,
    options,
    signal,
  ) => {
    return await submitManualGrantCommand(
      { connectorSlug, authMethod, inputValues, options },
      signal,
    );
  };
  const [, runConnectSuccess] = useLoadableSet(runConnectorConnectSuccess$);
  const pageSignal = useGet(pageSignal$);
  const externalCodeCompleting =
    completeExternalCodeLoadable.state === "loading";
  const manualGrantSubmitting = manualGrantLoadable.state === "loading";
  const noAuthSubmitting = noAuthLoadable.state === "loading";
  const entries = getConnectEntries(item, accountMode, reconnectAuthMethod);
  const onConnectSuccess = async (connectionId: string | null) => {
    await runConnectSuccess(item.slug, onSuccess, connectionId, pageSignal);
  };
  const connectOAuthAuthCodeAndSettle: ConnectOAuthAuthCodeAndSettleFn = async (
    connectorSlug,
    method,
    connectSuccess,
    options,
    signal,
  ) => {
    await connectOAuthAuthCodeAndSettleCommand(
      {
        connectorSlug,
        method,
        onSuccess: connectSuccess,
        options,
      },
      signal,
    );
  };
  const connectOAuthDeviceAuthAndSettleCommandFn: ConnectOAuthDeviceAuthAndSettleFn =
    async (args, signal) => {
      await connectOAuthDeviceAuthAndSettle(
        {
          connectorSlug: args.connectorSlug,
          authMethod: args.authMethod,
          onSuccess: args.onSuccess,
          options: args.options,
          startOptions: args.startOptions,
        },
        signal,
      );
    };
  const connectExternalCode: ConnectExternalCodeFn = async (args, signal) => {
    await connectExternalCodeCommand(args, signal);
  };
  const completeExternalCodeAndSettle: CompleteExternalCodeAndSettleFn = async (
    args,
    signal,
  ) => {
    await completeExternalCodeAndSettleCommand(args, signal);
  };
  const connectNoAuthAndSettle: ConnectNoAuthAndSettleFn = async (
    args,
    signal,
  ) => {
    await connectNoAuthAndSettleCommand(args, signal);
  };

  const progressContent = useConnectorProgressContent(item.slug, {
    browser: settleLoadable.state === "loading",
    device: deviceAuthLoadable.state === "loading",
    external: externalCodeCompleting,
  });
  if (progressContent) {
    return progressContent;
  }

  return (
    <StandardConnectMethodsContent
      item={item}
      agentId={agentId}
      onSuccess={onConnectSuccess}
      authorizeVisibleAgentsOnConnect={authorizeVisibleAgentsOnConnect}
      accountOptions={accountOptions}
      accountMode={accountMode}
      reconnectAuthMethod={reconnectAuthMethod}
      connectOAuthAuthCodeAndSettle={connectOAuthAuthCodeAndSettle}
      connectOAuthDeviceAuthAndSettle={connectOAuthDeviceAuthAndSettleCommandFn}
      connectExternalCode={connectExternalCode}
      completeExternalCodeAndSettle={completeExternalCodeAndSettle}
      connectNoAuthAndSettle={connectNoAuthAndSettle}
      submitManualGrant={submitManualGrant}
      externalCodeCompleting={externalCodeCompleting}
      manualGrantSubmitting={manualGrantSubmitting}
      noAuthSubmitting={noAuthSubmitting}
      entries={entries}
    />
  );
}

// ---------------------------------------------------------------------------
// Connect modal opened when configuring a connector.
// ---------------------------------------------------------------------------

export function ConnectModal({
  item,
  onClose,
  onSuccess,
  authorizeVisibleAgentsOnConnect = false,
  agentId,
  accountOptions,
  accountMode,
  reconnectAuthMethod,
}: {
  item: PlatformConnectorCatalogStatusItem;
  onClose: () => void;
  onSuccess?: (connectionId: string | null) => void | Promise<void>;
  authorizeVisibleAgentsOnConnect?: boolean;
  agentId?: string;
  accountOptions: ConnectorAccountMutationOptions;
  accountMode?: ConnectorAccountConnectMode;
  reconnectAuthMethod?: ConnectorAuthMethodId;
}) {
  const clearConnectorOAuthDeviceAuth = useSet(clearConnectorOAuthDeviceAuth$);
  const clearConnectorExternalCode = useSet(clearConnectorExternalCode$);
  const connectFlowConnectorSlug = useGet(connectFlowConnectorSlug$);
  const pollingConnectorSlug = useGet(pollingOAuthAuthCodeConnectorSlug$);
  const connectorOAuthDeviceAuthState = useGet(connectorOAuthDeviceAuthState$);
  const connectorExternalCodeState = useGet(connectorExternalCodeState$);
  const dismissProgress = useSet(dismissConnectorConnectionProgress$);

  const selectedConnectorSlug = item.slug;

  const connectFlowActive =
    connectFlowConnectorSlug === selectedConnectorSlug ||
    pollingConnectorSlug === selectedConnectorSlug ||
    connectorOAuthDeviceAuthFlowIsActive(
      connectorOAuthDeviceAuthState,
      selectedConnectorSlug,
    ) ||
    connectorExternalCodeFlowIsActive(
      connectorExternalCodeState,
      selectedConnectorSlug,
    );

  return (
    <Dialog
      open
      onOpenChange={(open, eventDetails) => {
        if (
          !open &&
          connectFlowActive &&
          eventDetails.reason === "outside-press"
        ) {
          eventDetails.cancel();
          return;
        }
        if (!open) {
          dismissProgress();
          clearConnectorOAuthDeviceAuth();
          clearConnectorExternalCode();
          onClose();
        }
      }}
    >
      <DialogContent maxWidth="md" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-5 w-5 shrink-0 items-center justify-center">
              <ConnectorIcon icon={item.icon} size={20} />
            </div>
            <DialogTitle>{item.label}</DialogTitle>
          </div>
        </DialogHeader>

        {item.connected && !accountMode && (
          <p className="wrap-anywhere text-sm text-muted-foreground">
            {connectedStatusText(item)}
          </p>
        )}

        <ConnectorConnectionDialogBody>
          <ConnectModalContent
            item={item}
            agentId={agentId}
            authorizeVisibleAgentsOnConnect={authorizeVisibleAgentsOnConnect}
            accountOptions={accountOptions}
            accountMode={accountMode}
            reconnectAuthMethod={reconnectAuthMethod}
            onSuccess={async (connectionId) => {
              await onSuccess?.(connectionId);
              clearConnectorOAuthDeviceAuth();
              clearConnectorExternalCode();
              onClose();
            }}
          />
        </ConnectorConnectionDialogBody>
        {item.slug === "mercury" ? (
          <MercuryDisclosure className="border-t border-border/50 pt-4" />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Connector card (shows Connect button when not connected)
// ---------------------------------------------------------------------------
