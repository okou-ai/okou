import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import {
  myOkouSignals$,
  myOkouSectionRef$,
  type MyOkouSignals,
} from "../../../../../signals/my-okou.ts";
import { settingsActionSignal$ } from "../../../../../signals/okou-page/settings/settings-dialog.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";
import { TiptapInstructionsEditor } from "../../../tiptap-instructions-editor.tsx";
import { UnsavedBar } from "../../../unsaved-bar.tsx";
import { InstructionsConflict } from "../../../instructions-conflict.tsx";

export function MyOkouSection() {
  const signals = useLoadable(myOkouSignals$);
  const sectionRef = useSet(myOkouSectionRef$);
  return (
    <section ref={sectionRef}>
      {signals.state === "hasData" ? (
        <PersonalInstructions signals={signals.data} />
      ) : (
        <LoadingInstructions />
      )}
    </section>
  );
}

function LoadingInstructions() {
  return (
    <div className="mx-auto h-64 w-full max-w-[900px] animate-pulse rounded-lg bg-muted/30" />
  );
}

function PersonalInstructions({
  signals,
}: {
  readonly signals: MyOkouSignals;
}) {
  const { t } = useTranslation();
  const saved = useLastLoadable(signals.saved$);
  const draft = useGet(signals.draft$);
  const saveConflict = useGet(signals.conflict$);
  const conflict =
    saveConflict ||
    (draft !== null &&
      saved.state === "hasData" &&
      draft.version !== saved.data.version);
  const discard = useSet(signals.discard$);
  const signal = useGet(settingsActionSignal$);
  const [result, save] = useLoadableSet(signals.save$);
  const [reloadResult, reloadLatest] = useLoadableSet(signals.reloadLatest$);
  const saving = result.state === "loading" || reloadResult.state === "loading";
  const dirty = draft !== null;
  if (!signal) {
    return null;
  }
  return (
    <div className="flex flex-col">
      <PersonalInstructionsEditor signals={signals} disabled={saving} />
      {draft !== null &&
        (result.state === "hasError" || reloadResult.state === "hasError") && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {t(($) => {
              return $.myOkou.saveError;
            })}
          </p>
        )}
      {conflict && (
        <InstructionsConflict
          loading={saving}
          onReload={() => {
            detach(reloadLatest(signal), Reason.DomCallback);
          }}
        />
      )}
      <InstructionsHints dirty={dirty} />
      {(dirty || saving) && (
        <UnsavedBar
          pinning="scrollport"
          saving={saving}
          saveDisabled={conflict || saved.state !== "hasData"}
          onDiscard={() => {
            if (conflict) {
              detach(reloadLatest(signal), Reason.DomCallback);
            } else {
              discard();
            }
          }}
          onSave={() => {
            detach(save(signal), Reason.DomCallback);
          }}
          saveLabel={
            saving
              ? t(($) => {
                  return $.myOkou.saving;
                })
              : t(($) => {
                  return $.myOkou.save;
                })
          }
          discardLabel={t(($) => {
            return $.myOkou.discard;
          })}
          message={t(($) => {
            return $.myOkou.unsaved;
          })}
        />
      )}
    </div>
  );
}

function PersonalInstructionsEditor({
  signals,
  disabled,
}: {
  readonly signals: MyOkouSignals;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const saved = useLastLoadable(signals.saved$);
  const draft = useGet(signals.draft$);
  const revision = useGet(signals.revision$);
  const edit = useSet(signals.edit$);
  const retry = useSet(signals.retry$);
  const content =
    draft?.content ?? (saved.state === "hasData" ? saved.data.content : "");
  return (
    <>
      {saved.state === "loading" ? (
        <LoadingInstructions />
      ) : saved.state === "hasError" ? (
        <div role="alert" className="space-y-3 text-sm text-destructive">
          <p>
            {t(($) => {
              return $.myOkou.loadError;
            })}
          </p>
          <Button
            variant="outline"
            onClick={() => {
              retry();
            }}
          >
            {t(($) => {
              return $.myOkou.retry;
            })}
          </Button>
        </div>
      ) : (
        <TiptapInstructionsEditor
          key={`${revision}:${draft?.version ?? saved.data.version}`}
          initialContent={content}
          onChange={(value) => {
            edit(value, saved.data);
          }}
          disabled={disabled}
          ariaLabel={t(($) => {
            return $.myOkou.instructions;
          })}
          placeholder={t(($) => {
            return $.myOkou.placeholder;
          })}
          footerHint={t(($) => {
            return $.myOkou.markdown;
          })}
        />
      )}
    </>
  );
}

function InstructionsHints({ dirty }: { readonly dirty: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <p className="mt-3 text-sm text-muted-foreground">
        {t(($) => {
          return $.myOkou.timing;
        })}
      </p>
      {dirty && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t(($) => {
            return $.myOkou.draftKept;
          })}
        </p>
      )}
    </>
  );
}
