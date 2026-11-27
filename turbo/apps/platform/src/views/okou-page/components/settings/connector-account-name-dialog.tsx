import type { FormEvent } from "react";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { TFunction } from "i18next";
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
  Radio,
  RadioGroup,
} from "@okouai/ui";

import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  CONNECTOR_ACCOUNT_NAME_PRESETS,
  type ConnectorAccountNamePreset,
  closeConnectorAccountNamePrompt$,
  connectorAccountNamePromptChoice$,
  connectorAccountNamePromptValue$,
  isConnectorAccountNameChoice,
  saveConnectorAccountNamePrompt$,
  setConnectorAccountNamePromptChoice$,
  setConnectorAccountNamePromptValue$,
} from "../../../../signals/okou-page/settings/connector-account-dialogs.ts";
import { visibleConnectorAccountNamePrompt$ } from "../../../../signals/okou-page/settings/connector-account-name-prompt.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

const NAME_PROMPT_LABEL_ID = "connector-account-name-label";
const NAME_PROMPT_CUSTOM_HINT_ID = "connector-account-name-custom-hint";

function presetLabel(t: TFunction, preset: ConnectorAccountNamePreset): string {
  switch (preset) {
    case "primary": {
      return t(($) => {
        return $.connectors.accounts.namePresets.primary;
      });
    }
    case "secondary": {
      return t(($) => {
        return $.connectors.accounts.namePresets.secondary;
      });
    }
    case "personal": {
      return t(($) => {
        return $.connectors.accounts.namePresets.personal;
      });
    }
    case "work": {
      return t(($) => {
        return $.connectors.accounts.namePresets.work;
      });
    }
    case "customer": {
      return t(($) => {
        return $.connectors.accounts.namePresets.customer;
      });
    }
    case "company": {
      return t(($) => {
        return $.connectors.accounts.namePresets.company;
      });
    }
  }
}

export function ConnectorAccountNameDialog() {
  const { t } = useTranslation();
  const prompt = useGet(visibleConnectorAccountNamePrompt$);
  const choice = useGet(connectorAccountNamePromptChoice$);
  const setChoice = useSet(setConnectorAccountNamePromptChoice$);
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
          <div className="flex flex-col gap-3">
            <div id={NAME_PROMPT_LABEL_ID} className="text-sm font-medium">
              {t(($) => {
                return $.connectors.accounts.accountName;
              })}
            </div>
            <RadioGroup
              aria-labelledby={NAME_PROMPT_LABEL_ID}
              value={choice}
              onValueChange={(next) => {
                if (isConnectorAccountNameChoice(next)) {
                  setChoice(next);
                }
              }}
              className="flex flex-col gap-3"
            >
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                {CONNECTOR_ACCOUNT_NAME_PRESETS.map((preset) => {
                  return (
                    <label
                      key={preset}
                      className="flex cursor-default items-center gap-2.5 py-0.5 text-sm text-foreground"
                    >
                      <Radio value={preset} />
                      <span>{presetLabel(t, preset)}</span>
                    </label>
                  );
                })}
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex cursor-default items-center gap-2.5 py-0.5 text-sm text-foreground">
                  <Radio value="custom" />
                  <span>
                    {t(($) => {
                      return $.connectors.accounts.namePresetCustom;
                    })}
                  </span>
                </label>
                {choice === "custom" ? (
                  <div className="flex flex-col gap-1.5 pl-6.5">
                    <Input
                      autoFocus
                      aria-label={t(($) => {
                        return $.connectors.accounts.namePresetCustom;
                      })}
                      aria-describedby={NAME_PROMPT_CUSTOM_HINT_ID}
                      value={value}
                      onChange={(event) => {
                        return setValue(event.target.value);
                      }}
                      maxLength={255}
                    />
                    <p
                      id={NAME_PROMPT_CUSTOM_HINT_ID}
                      className="text-xs text-muted-foreground"
                    >
                      {t(($) => {
                        return $.connectors.accounts.namePromptCustomHint;
                      })}
                    </p>
                  </div>
                ) : null}
              </div>
            </RadioGroup>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t(($) => {
                return $.connectors.accounts.skipName;
              })}
            </Button>
            <Button type="submit" disabled={renameLoadable.state === "loading"}>
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
