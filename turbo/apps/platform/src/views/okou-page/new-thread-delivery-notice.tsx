import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import {
  deliveryIntents$,
  type NewThreadDeliveryIntent,
} from "../../signals/chat-page/chat-delivery-intents.ts";
import {
  newThreadDeliveryOnRef$,
  retryNewThreadDelivery$,
} from "../../signals/chat-page/new-thread-delivery.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";

function NewThreadDeliveryItem({
  intent,
}: {
  intent: NewThreadDeliveryIntent;
}) {
  const [retryState, retry] = useLoadableSet(retryNewThreadDelivery$);
  const signal = useGet(rootSignal$);
  const { t } = useTranslation();
  const phase =
    intent.phase === "create"
      ? t(($) => {
          return $.chat.newThreadDelivery.create;
        })
      : t(($) => {
          return $.chat.newThreadDelivery.firstMessage;
        });
  const savedText =
    intent.body.userMessage?.parts
      .flatMap((part) => {
        return part.type === "text" ? [part.text] : [];
      })
      .join("\n") ?? intent.body.prompt;
  const filenames =
    intent.body.userMessage?.parts.flatMap((part) => {
      return part.type === "file" ? [part.filenameSnapshot] : [];
    }) ?? [];
  const status =
    intent.status === "rejected"
      ? intent.rejection === "authentication"
        ? t(
            ($) => {
              return $.chat.newThreadDelivery.rejectedAuth;
            },
            { phase },
          )
        : t(
            ($) => {
              return $.chat.newThreadDelivery.rejected;
            },
            { phase },
          )
      : intent.status === "uncertain"
        ? intent.rejection === "authentication"
          ? t(
              ($) => {
                return $.chat.newThreadDelivery.uncertainAuth;
              },
              { phase },
            )
          : t(
              ($) => {
                return $.chat.newThreadDelivery.uncertain;
              },
              { phase },
            )
        : intent.status === "accepted"
          ? t(($) => {
              return $.chat.newThreadDelivery.accepted;
            })
          : intent.phase === "create"
            ? t(($) => {
                return $.chat.newThreadDelivery.pendingCreate;
              })
            : t(($) => {
                return $.chat.newThreadDelivery.pendingPrompt;
              });
  return (
    <div
      data-new-thread-delivery-id={intent.clientEventId}
      role={intent.status === "rejected" ? "alert" : "status"}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-xs last:border-0"
    >
      <span className="min-w-0 flex-1">{status}</span>
      {intent.phase === "prompt" ? (
        <Link
          pathname="/chats/:threadId"
          options={{ pathParams: { threadId: intent.threadId } }}
          className="shrink-0 underline"
        >
          {t(($) => {
            return $.chat.newThreadDelivery.openChat;
          })}
        </Link>
      ) : null}
      {intent.status === "rejected" || intent.status === "uncertain" ? (
        <Button
          type="button"
          size="sm"
          variant="neutral"
          disabled={retryState.state === "loading" || !navigator.locks}
          onClick={() => {
            detach(
              retry(intent.threadId, intent.clientEventId, signal),
              Reason.DomCallback,
            );
          }}
        >
          {retryState.state === "loading"
            ? t(($) => {
                return $.chat.newThreadDelivery.checking;
              })
            : t(($) => {
                return $.chat.newThreadDelivery.checkAndRetry;
              })}
        </Button>
      ) : null}
      {!navigator.locks &&
      (intent.status === "rejected" || intent.status === "uncertain") ? (
        <span>
          {t(($) => {
            return $.chat.newThreadDelivery.safeRetry;
          })}
        </span>
      ) : null}
      {intent.status === "rejected" || intent.status === "uncertain" ? (
        <details className="w-full min-w-0">
          <summary className="cursor-pointer underline">
            {t(($) => {
              return $.chat.newThreadDelivery.review;
            })}
          </summary>
          <p className="mt-1 whitespace-pre-wrap break-words">{savedText}</p>
          {filenames.length > 0 ? (
            <p className="mt-1 break-words">
              {t(
                ($) => {
                  return $.chat.newThreadDelivery.uploadedFiles;
                },
                { files: filenames.join(", ") },
              )}
            </p>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

/** Mounted above all chat pages so an uncreated thread still has a recovery path. */
export function NewThreadDeliveryNotice() {
  const onRef = useSet(newThreadDeliveryOnRef$);
  const { t } = useTranslation();
  // Do not render a previous account's cached result while auth/org is changing.
  const loadable = useLoadable(deliveryIntents$);
  const intents =
    loadable.state === "hasData"
      ? loadable.data.filter((intent): intent is NewThreadDeliveryIntent => {
          return intent.kind === "new-thread";
        })
      : [];
  return (
    <>
      <span ref={onRef} aria-hidden hidden />
      {intents.length > 0 ? (
        <section
          aria-label={t(($) => {
            return $.chat.newThreadDelivery.region;
          })}
          className="max-h-40 shrink-0 overflow-y-auto border-b border-border bg-background text-foreground"
        >
          {intents.map((intent) => {
            return (
              <NewThreadDeliveryItem
                key={intent.clientEventId}
                intent={intent}
              />
            );
          })}
        </section>
      ) : null}
    </>
  );
}
