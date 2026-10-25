import type { FormEvent } from "react";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@okouai/ui";

import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  closeConnectorAccountNamePrompt$,
  connectorAccountNamePromptValue$,
  saveConnectorAccountNamePrompt$,
  setConnectorAccountNamePromptValue$,
} from "../../../../signals/okou-page/settings/connector-account-dialogs.ts";
import { visibleConnectorAccountNamePrompt$ } from "../../../../signals/okou-page/settings/connector-account-name-prompt.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { useConnectorAccountLabel } from "./use-connector-account-label.ts";

export function ConnectorAccountNameDialog() {
  const { t } = useTranslation();
  const accountLabel = useConnectorAccountLabel();
  const prompt = useGet(visibleConnectorAccountNamePrompt$);
  const value = useGet(connectorAccountNamePromptValue$);
  const setValue = useSet(setConnectorAccountNamePromptValue$);
  const close = useSet(closeConnectorAccountNamePrompt$);
  const [renameLoadable, rename] = useLoadableSet(
    saveConnectorAccountNamePrompt$,
  );
  const signal = useGet(pageSignal$);

  if (!prompt) {
    return null;
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    detach(rename(signal), Reason.DomCallback);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && close();
      }}
    >
      <DialogContent maxWidth="md">
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="line-clamp-2 break-words pr-8 leading-snug">
              {t(
                ($) => {
                  return $.connectors.accounts.namePromptTitle;
                },
                { connector: prompt.connectorLabel },
              )}
            </DialogTitle>
            <DialogDescription>
              {t(($) => {
                return $.connectors.accounts.namePromptDescription;
              })}
            </DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              {t(($) => {
                return $.connectors.accounts.accountName;
              })}
            </span>
            <Input
              autoFocus
              value={value}
              onChange={(event) => {
                return setValue(event.target.value);
              }}
              placeholder={accountLabel(prompt.account)}
              maxLength={255}
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t(($) => {
                return $.connectors.accounts.skipName;
              })}
            </Button>
            <Button
              type="submit"
              disabled={!value.trim() || renameLoadable.state === "loading"}
            >
              {t(($) => {
                return $.connectors.actions.save;
              })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
