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
import { useGet, useSet } from "ccstate-react";
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
  connectCustomConnectorAuthorization$,
  connectCustomConnectorAuthorizationForAgent$,
  customConnectorConnectForm$,
  resetCustomConnectorConnectInput$,
  setCustomConnectorConnectField$,
  setCustomConnectorValues$,
  setCustomConnectorValuesForAgent$,
} from "../../../../signals/okou-page/settings/custom-connectors.ts";
import { sanitizeTokenInputRecord } from "../../../../signals/okou-page/settings/token-input.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { CustomConnectorIcon } from "./custom-connector-icon.tsx";
import type {
  ConnectorAccountConnectMode,
  ConnectorAccountMutationOptions,
} from "../../../../signals/okou-page/settings/connector-account-dialogs.ts";

interface CustomConnectorConnectionSubmission {
  readonly connected: boolean;
  readonly targetAuthorized: boolean;
  readonly connectionId: string | null;
}

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
      : connector.missingRequiredFields;
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

function useCustomConnectorConnectionSubmitters(
  agentId: string | undefined,
  accountOptions: ConnectorAccountMutationOptions,
) {
  const [valuesLoadable, submitValues] = useLoadableSet(
    setCustomConnectorValues$,
  );
  const [agentValuesLoadable, submitAgentValues] = useLoadableSet(
    setCustomConnectorValuesForAgent$,
  );
  const [authorizationLoadable, submitAuthorization] = useLoadableSet(
    connectCustomConnectorAuthorization$,
  );
  const [agentAuthorizationLoadable, submitAgentAuthorization] = useLoadableSet(
    connectCustomConnectorAuthorizationForAgent$,
  );
  const account = accountOptions.account;
  const usesDefaultProjection =
    accountOptions.useDefaultConnectorProjection === true;

  const submitDeclaredValues = async (
    args: {
      readonly id: string;
      readonly values: readonly CustomConnectorValueInput[];
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionSubmission> => {
    if (agentId) {
      return await submitAgentValues({ ...args, agentId, account }, signal);
    }
    return await submitValues({ ...args, account }, signal);
  };
  const submitAuthorizationMode = async (
    connectorId: string,
    onSuccess: (
      result: CustomConnectorConnectionSubmission,
      signal: AbortSignal,
    ) => Promise<void>,
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionSubmission> => {
    if (agentId) {
      return await submitAgentAuthorization(
        {
          id: connectorId,
          agentId,
          account,
          onSuccess,
          ...(usesDefaultProjection
            ? { useDefaultConnectorProjection: true as const }
            : {}),
        },
        signal,
      );
    }
    return await submitAuthorization(
      {
        id: connectorId,
        account,
        onSuccess,
        ...(usesDefaultProjection
          ? { useDefaultConnectorProjection: true as const }
          : {}),
      },
      signal,
    );
  };

  return {
    submitting:
      valuesLoadable.state === "loading" ||
      agentValuesLoadable.state === "loading" ||
      authorizationLoadable.state === "loading" ||
      agentAuthorizationLoadable.state === "loading",
    submitDeclaredValues,
    submitAuthorizationMode,
  };
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
  readonly accountOptions: ConnectorAccountMutationOptions;
  readonly accountMode?: ConnectorAccountConnectMode;
}

function CustomConnectorConnectForm({
  connector,
  accountMode,
  values,
  setField,
  submitting,
  canSubmit,
  close,
  onSubmit,
}: {
  readonly connector: CustomConnectorResponse;
  readonly accountMode: ConnectorAccountConnectMode | undefined;
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
          configuredFieldKeys={accountMode ? [] : connector.configuredFieldKeys}
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
  const setField = useSet(setCustomConnectorConnectField$);
  const close = useCloseCustomConnectorDialog(onClose);
  const {
    submitting: connectionSubmitting,
    submitDeclaredValues,
    submitAuthorizationMode,
  } = useCustomConnectorConnectionSubmitters(agentId, accountOptions);
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
  );
  const canSubmit =
    !submitting &&
    (authorization || (hasRequiredValues && (noAuth || values.length > 0)));
  const showSecretDescription =
    !authorization &&
    connector.fields.length === 1 &&
    connector.fields[0]?.kind === "secret";

  const { close: cancel, onOpenChange } = useConnectorConnectionDialogClose(
    connectionSubmitting,
    close,
  );

  const finish = async (
    result: CustomConnectorConnectionSubmission,
    attemptSignal: AbortSignal,
  ) => {
    if (!result.connected) {
      return;
    }
    if (result.targetAuthorized || accountMode) {
      await onSuccess?.(result.connectionId, attemptSignal);
      attemptSignal.throwIfAborted();
    }
    close();
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    detach(
      (async () => {
        if (authorization) {
          await submitAuthorizationMode(connector.id, finish, signal);
          return;
        }
        const result = await submitDeclaredValues(
          { id: connector.id, values },
          signal,
        );
        await finish(result, signal);
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
          <CustomConnectorConnectForm
            connector={connector}
            accountMode={accountMode}
            values={form.values}
            setField={setField}
            submitting={submitting}
            canSubmit={canSubmit}
            close={cancel}
            onSubmit={onSubmit}
          />
        </ConnectorConnectionDialogBody>
      </DialogContent>
    </Dialog>
  );
}
