import type { FormEvent } from "react";

import {
  isIntegrationManagedCustomConnector,
  customConnectorManagedStatusSchema,
} from "@okouai/api-contracts/validators/custom-connectors";
import type {
  CustomConnectorValueInput,
  CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui";
import { Input } from "@okouai/ui/components/ui/input";
import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  connectorAccountSetup,
  connectorAccountSetupRef$,
} from "../../../../signals/okou-page/settings/connector-accounts.ts";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";

import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  submitCustomConnectorConnection$,
  cancelCustomConnectorConnection$,
  customConnectorConnectForm$,
  setCustomConnectorConnectField$,
} from "../../../../signals/okou-page/settings/custom-connectors.ts";
import { sanitizeTokenInputRecord } from "../../../../signals/okou-page/settings/token-input.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { CustomConnectorIcon } from "./custom-connector-icon.tsx";
import type {
  ConnectorAccountConnectMode,
  CustomConnectorAccountMutationOptions,
} from "../../../../signals/okou-page/settings/connector-account-dialogs.ts";

function formValue(
  values: Readonly<Record<string, string>>,
  key: string,
): string {
  return Object.hasOwn(values, key) ? values[key] : "";
}

function declaredValuesFromForm(
  connector: CustomConnectorResponse,
  values: Readonly<Record<string, string>>,
): readonly CustomConnectorValueInput[] {
  const variableKeys = new Set(
    connector.fields.flatMap((field) => {
      return field.kind === "variable" ? [field.key] : [];
    }),
  );
  const normalized = sanitizeTokenInputRecord(
    { ...values },
    { preserveWhitespaceKeys: variableKeys },
  );

  return connector.fields.flatMap((field): CustomConnectorValueInput[] => {
    const value = formValue(normalized, field.key);
    return value.length > 0
      ? [{ key: field.key, kind: field.kind, value }]
      : [];
  });
}

function customConnectorValuesReady(
  connector: CustomConnectorResponse,
  values: readonly CustomConnectorValueInput[],
  mode: ConnectorAccountConnectMode | undefined,
  missingRequiredFields: readonly string[],
): boolean {
  const submittedKeys = new Set(
    values.map((value) => {
      return value.key;
    }),
  );
  const requiredKeys =
    mode?.kind === "add"
      ? connector.fields.flatMap((field) => {
          return field.required ? [field.key] : [];
        })
      : missingRequiredFields;
  return requiredKeys.every((key) => {
    return submittedKeys.has(key);
  });
}

function CredentialFields({
  connector,
  configuredFieldKeys,
  values,
  setField,
}: {
  readonly connector: CustomConnectorResponse;
  readonly configuredFieldKeys: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly setField: (args: {
    readonly key: string;
    readonly value: string;
  }) => void;
}) {
  const { t } = useTranslation();
  const configuredKeys = new Set(configuredFieldKeys);
  return connector.fields.map((field, index) => {
    const inputId = `cc-connect-field-${index}`;
    const statusId = `${inputId}-status`;
    const descriptionId = field.description
      ? `${inputId}-description`
      : undefined;
    const configured = configuredKeys.has(field.key);
    const status = field.required
      ? t(($) => {
          return $.connectors.card.required;
        })
      : t(($) => {
          return $.connectors.card.optional;
        });
    const configuredStatus = configured
      ? t(($) => {
          return $.connectors.custom.connect.configured;
        })
      : null;

    return (
      <div key={field.key} className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-foreground"
          >
            {field.label}
          </label>
          <span id={statusId} className="text-xs text-muted-foreground">
            {status}
            {configuredStatus ? ` · ${configuredStatus}` : ""}
          </span>
        </div>
        {field.description && (
          <p id={descriptionId} className="text-xs text-muted-foreground">
            {field.description}
          </p>
        )}
        <Input
          id={inputId}
          name={`custom-connector-${connector.id}-${field.key}`}
          type={field.kind === "secret" ? "password" : "text"}
          value={formValue(values, field.key)}
          onChange={(event) => {
            setField({ key: field.key, value: event.target.value });
          }}
          autoComplete="off"
          aria-describedby={
            descriptionId ? `${descriptionId} ${statusId}` : statusId
          }
          autoFocus={index === 0}
        />
      </div>
    );
  });
}

function ConnectDialogFooter({
  authorization,
  noAuth,
  submitting,
  canSubmit,
  onClose,
}: {
  readonly authorization: boolean;
  readonly noAuth: boolean;
  readonly submitting: boolean;
  readonly canSubmit: boolean;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const submitLabel = submitting
    ? authorization || noAuth
      ? t(($) => {
          return $.connectors.custom.connect.connecting;
        })
      : t(($) => {
          return $.connectors.custom.connect.saving;
        })
    : authorization
      ? t(($) => {
          return $.connectors.custom.connect.continue;
        })
      : noAuth
        ? t(($) => {
            return $.connectors.custom.connect.connect;
          })
        : t(($) => {
            return $.connectors.custom.connect.save;
          });
  return (
    <DialogFooter>
      <Button
        type="button"
        variant="outline"
        onClick={onClose}
        disabled={submitting && !authorization}
      >
        {t(($) => {
          return $.connectors.actions.cancel;
        })}
      </Button>
      <Button type="submit" disabled={!canSubmit}>
        {submitLabel}
      </Button>
    </DialogFooter>
  );
}

interface CustomConnectorConnectDialogProps {
  readonly connector: CustomConnectorResponse;
  readonly agentId?: string;
  readonly onClose?: () => void;
  readonly onConnected?: (
    connectionId: string,
    signal: AbortSignal,
  ) => void | Promise<void>;
  readonly onSuccess?: (
    connectionId: string,
    signal: AbortSignal,
  ) => void | Promise<void>;
  readonly accountOptions: CustomConnectorAccountMutationOptions;
  readonly accountMode?: ConnectorAccountConnectMode;
}

function CustomConnectorConnectForm({
  connector,
  configuredFieldKeys,
  values,
  setField,
  submitting,
  canSubmit,
  close,
  onSubmit,
}: {
  readonly connector: CustomConnectorResponse;
  readonly configuredFieldKeys: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly setField: (args: {
    readonly key: string;
    readonly value: string;
  }) => void;
  readonly submitting: boolean;
  readonly canSubmit: boolean;
  readonly close: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { t } = useTranslation();
  const authorization =
    connector.authMode === "oauth" || connector.authMode === "automatic";
  const noAuth = connector.authMode === "none";
  return (
    <form
      autoComplete="off"
      className="flex flex-col gap-4"
      onSubmit={onSubmit}
    >
      {authorization ? (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return connector.authMode === "automatic"
              ? $.connectors.custom.connect.continueWithAutomatic
              : $.connectors.custom.connect.continueToProvider;
          })}
        </p>
      ) : (
        <CredentialFields
          connector={connector}
          configuredFieldKeys={configuredFieldKeys}
          values={values}
          setField={setField}
        />
      )}
      <ConnectDialogFooter
        authorization={authorization}
        noAuth={noAuth}
        submitting={submitting}
        canSubmit={canSubmit}
        onClose={close}
      />
    </form>
  );
}

function useCustomConnectorAccountSetup(
  connector: CustomConnectorResponse,
  accountMode: CustomConnectorConnectDialogProps["accountMode"],
) {
  const accounts = useLastLoadable(connectorAccountSetup.accounts$);
  const account =
    accountMode?.kind === "reconnect"
      ? accountMode.account
      : accountMode?.kind === "add"
        ? undefined
        : accounts.state === "hasData"
          ? accounts.data.defaultConnection
          : undefined;
  const setupAvailable =
    accountMode?.kind === "add" ||
    accountMode?.kind === "reconnect" ||
    (accounts.state === "hasData" && accounts.data.available);
  const missingRequiredFields =
    account?.missingRequiredFields ??
    connector.fields
      .filter((field) => {
        return field.required;
      })
      .map((field) => {
        return field.key;
      });
  const configuredFieldKeys = account?.configuredFieldKeys ?? [];
  return { setupAvailable, missingRequiredFields, configuredFieldKeys };
}

function CustomConnectorValuesConnectDialog(
  props: CustomConnectorConnectDialogProps,
) {
  const setup = useCustomConnectorAccountSetup(
    props.connector,
    props.accountMode,
  );
  const setupRef = useSet(connectorAccountSetupRef$);
  return (
    <div
      ref={setupRef}
      data-account-setup-custom-id={
        props.accountMode ? undefined : props.connector.id
      }
    >
      <CustomConnectorConnectDialogContent {...props} {...setup} />
    </div>
  );
}

export function CustomConnectorConnectDialog(
  props: CustomConnectorConnectDialogProps,
) {
  const { connector } = props;
  if (isIntegrationManagedCustomConnector(connector)) {
    const status = customConnectorManagedStatusSchema.parse(connector);
    return (
      <CustomConnectorConnectDialogContent
        {...props}
        setupAvailable
        missingRequiredFields={status.missingRequiredFields}
        configuredFieldKeys={status.configuredFieldKeys}
      />
    );
  }
  if (connector.authMode === "oauth" || connector.authMode === "automatic") {
    // Authorization starts resolve the account in their command; no saved
    // field configuration is needed before opening the provider window.
    return (
      <CustomConnectorConnectDialogContent
        {...props}
        setupAvailable
        missingRequiredFields={[]}
        configuredFieldKeys={[]}
      />
    );
  }
  return <CustomConnectorValuesConnectDialog {...props} />;
}

function CustomConnectorSecretDescription({
  connector,
}: {
  readonly connector: CustomConnectorResponse;
}) {
  const { t } = useTranslation();
  if (
    connector.authMode !== "manual" ||
    connector.fields.length !== 1 ||
    connector.fields[0]?.kind !== "secret"
  ) {
    return null;
  }
  return (
    <p className="text-sm text-muted-foreground">
      {t(($) => {
        return $.connectors.custom.connect.description;
      })}
    </p>
  );
}

function CustomConnectorConnectDialogContent({
  connector,
  agentId,
  onClose,
  onConnected,
  onSuccess,
  accountOptions,
  accountMode,
  setupAvailable,
  missingRequiredFields,
  configuredFieldKeys,
}: CustomConnectorConnectDialogProps & {
  readonly setupAvailable: boolean;
  readonly missingRequiredFields: readonly string[];
  readonly configuredFieldKeys: readonly string[];
}) {
  const { t } = useTranslation();
  const form = useGet(customConnectorConnectForm$);
  const setField = useSet(setCustomConnectorConnectField$);
  const [connectionLoadable, submit] = useLoadableSet(
    submitCustomConnectorConnection$,
  );
  const submitting = connectionLoadable.state === "loading";
  const cancelConnection = useSet(cancelCustomConnectorConnection$);
  const signal = useGet(pageSignal$);
  const authorization =
    connector.authMode === "oauth" || connector.authMode === "automatic";
  const noAuth = connector.authMode === "none";
  const values = declaredValuesFromForm(connector, form.values);
  const hasRequiredValues = customConnectorValuesReady(
    connector,
    values,
    accountMode,
    missingRequiredFields,
  );
  const canSubmit =
    !submitting &&
    setupAvailable &&
    (authorization || (hasRequiredValues && (noAuth || values.length > 0)));

  const cancel = () => {
    cancelConnection(onClose);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    detach(
      submit(
        {
          connector,
          agentId,
          values,
          accountOptions,
          accountMode,
          onConnected,
          onSuccess,
          onClose,
        },
        signal,
      ),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (!open && submitting && details.reason === "outside-press") {
          details.cancel();
          return;
        }
        if (!open) {
          cancel();
        }
      }}
    >
      <DialogContent
        maxWidth="md"
        aria-describedby={undefined}
        closeLabel={t(($) => {
          return $.connectors.actions.close;
        })}
      >
        <CustomConnectorConnectHeader connector={connector} />
        <CustomConnectorSecretDescription connector={connector} />
        <div>
          {connectionLoadable.state === "hasError" && (
            <p role="alert" className="text-sm text-destructive">
              {String(connectionLoadable.error)}
            </p>
          )}
          <CustomConnectorConnectForm
            connector={connector}
            configuredFieldKeys={configuredFieldKeys}
            values={form.values}
            setField={setField}
            submitting={submitting}
            canSubmit={canSubmit}
            close={cancel}
            onSubmit={onSubmit}
          />
          {!setupAvailable && (
            <p role="alert" className="text-sm text-muted-foreground">
              {t(($) => {
                return $.connectors.accounts.setupUnavailable;
              })}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CustomConnectorConnectHeader({
  connector,
}: {
  readonly connector: CustomConnectorResponse;
}) {
  const { t } = useTranslation();
  return (
    <DialogHeader>
      <div className="flex items-center gap-3">
        <CustomConnectorIcon
          id={connector.id}
          displayName={connector.displayName}
          size={20}
        />
        <DialogTitle>
          {t(
            ($) => {
              return $.connectors.custom.connect.title;
            },
            { connector: connector.displayName },
          )}
        </DialogTitle>
      </div>
    </DialogHeader>
  );
}
