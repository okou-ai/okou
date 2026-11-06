import { DetailPageShell } from "./components/detail-page-layout.tsx";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import { myOkouSignals$, type MyOkouSignals } from "../signals/my-okou.ts";
import { pageSignal$ } from "../signals/page-signal.ts";
import { detach, Reason } from "../signals/utils.ts";
import { TiptapInstructionsEditor } from "./okou-page/tiptap-instructions-editor.tsx";
import { UnsavedBar } from "./okou-page/unsaved-bar.tsx";
import { AvatarFromUrl } from "./okou-page/sidebar-shared.tsx";
import { DEFAULT_AGENT_AVATAR_URL } from "@okouai/core/agent-avatar";
import { InstructionsConflict } from "./okou-page/instructions-conflict.tsx";

export function MyOkouPage() {
  const signals = useLoadable(myOkouSignals$);
  return (
    <DetailPageShell>
      {signals.state === "hasData" ? (
        <PersonalInstructions signals={signals.data} />
      ) : (
        <LoadingInstructions />
      )}
    </DetailPageShell>
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
  const revision = useGet(signals.revision$);
  const saveConflict = useGet(signals.conflict$);
  const conflict =
    saveConflict ||
    (draft !== null &&
      saved.state === "hasData" &&
      draft.version !== saved.data.version);
  const edit = useSet(signals.edit$);
  const discard = useSet(signals.discard$);
  const retry = useSet(signals.retry$);
  const signal = useGet(pageSignal$);
  const [result, save] = useLoadableSet(signals.save$);
  const [reloadResult, reloadLatest] = useLoadableSet(signals.reloadLatest$);
  const saving = result.state === "loading" || reloadResult.state === "loading";
  const dirty = draft !== null;
  const content =
    draft?.content ?? (saved.state === "hasData" ? saved.data.content : "");
  return (
    <main className="mx-auto w-full max-w-[964px] px-4 pt-8 pb-32 sm:px-8 sm:pt-12">
      <MyOkouHeader />
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
          disabled={saving}
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
          saving={saving}
          saveDisabled={conflict || saved.state !== "hasData"}
          saveClassName="bg-foreground text-background hover:bg-foreground/90"
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
    </main>
  );
}

function MyOkouHeader() {
  const { t } = useTranslation();
  return (
    <>
      <header className="mb-8 flex items-center gap-4">
        <AvatarFromUrl
          avatarUrl={DEFAULT_AGENT_AVATAR_URL}
          alt=""
          className="h-14 w-14 rounded-xl object-cover object-top"
        />
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            {t(($) => {
              return $.myOkou.title;
            })}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(($) => {
              return $.myOkou.description;
            })}
          </p>
        </div>
      </header>
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
