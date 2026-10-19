import type { FormEvent } from "react";

import type {
  CustomConnectorResponse,
  CustomConnectorValueInput,
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
  connectorAccountSummaryByTarget$,
  connectorAccountTargetKey,
} from "../../../../signals/okou-page/connector-accounts.ts";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";

import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  connectorConnectionCompleted$,
  connectorConnectionPending$,
} from "../../../../signals/connector-connection-progress.ts";
import { useConnectorConnectionDialogClose } from "../../../components/connector-connection-progress.tsx";
import { ConnectorConnectionDialogBody } from "../../../components/connector-connection-dialog-body.tsx";
import {
  closeCustomConnectorDialog$,
  submitCustomConnectorConnection$,
  customConnectorConnectForm$,
  resetCustomConnectorConnectInput$,
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
          autoComplete={field.kind === "secret" ? "new-password" : "off"}
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
  const completed = useGet(connectorConnectionCompleted$);
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
          return submitting && authorization && completed
            ? $.connectors.actions.close
            : $.connectors.actions.cancel;
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
  readonly onSuccess?: (
    connectionId: string | null,
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
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
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

function useCloseCustomConnectorDialog(onClose: (() => void) | undefined) {
  const resetForm = useSet(resetCustomConnectorConnectInput$);
  const closeDialog = useSet(closeCustomConnectorDialog$);
  return () => {
    resetForm();
    if (onClose) {
      onClose();
    } else {
      closeDialog();
    }
  };
}

function useCustomConnectorAccountSetup(
  connector: CustomConnectorResponse,
  accountMode: CustomConnectorConnectDialogProps["accountMode"],
) {
  const summaries = useLastLoadable(connectorAccountSummaryByTarget$);
  const account =
    accountMode?.kind === "reconnect"
      ? accountMode.account
      : accountMode?.kind === "add"
        ? undefined
        : summaries.state === "hasData"
          ? summaries.data.get(
              connectorAccountTargetKey({
                kind: "custom",
                customConnectorId: connector.id,
              }),
            )?.defaultConnection
          : undefined;
  const setupAvailable =
    accountMode?.kind === "add" ||
    (accountMode?.kind === "reconnect"
      ? account?.setupStatus !== undefined
      : summaries.state === "hasData" &&
        (account === null ||
          account === undefined ||
          account.setupStatus !== undefined));
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

export function CustomConnectorConnectDialog({
  connector,
  agentId,
  onClose,
  onSuccess,
  accountOptions,
  accountMode,
}: CustomConnectorConnectDialogProps) {
  const { t } = useTranslation();
  const form = useGet(customConnectorConnectForm$);
  const { setupAvailable, missingRequiredFields, configuredFieldKeys } =
    useCustomConnectorAccountSetup(connector, accountMode);
  const setField = useSet(setCustomConnectorConnectField$);
  const close = useCloseCustomConnectorDialog(onClose);
  const [connectionLoadable, submit] = useLoadableSet(
    submitCustomConnectorConnection$,
  );
  const connectionSubmitting = connectionLoadable.state === "loading";
  const pending = useGet(connectorConnectionPending$);
  const submitting = connectionSubmitting || pending;
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
  const showSecretDescription =
    !authorization &&
    connector.fields.length === 1 &&
    connector.fields[0]?.kind === "secret";

  const { close: cancel, onOpenChange } = useConnectorConnectionDialogClose(
    connectionSubmitting,
    close,
  );

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    detach(
      (async () => {
        const connected = await submit(
          { connector, agentId, values, accountOptions, accountMode },
          onSuccess,
          signal,
        );
        if (connected) {
          close();
        }
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        maxWidth="md"
        aria-describedby={undefined}
        closeLabel={t(($) => {
          return $.connectors.actions.close;
        })}
      >
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
        {showSecretDescription && (
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.connectors.custom.connect.description;
            })}
          </p>
        )}
        <ConnectorConnectionDialogBody>
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
        </ConnectorConnectionDialogBody>
      </DialogContent>
    </Dialog>
  );
}
