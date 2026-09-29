import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
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
  const phase = intent.phase === "create" ? "Chat creation" : "First message";
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
        ? `${phase} rejected. Sign in with the original account and organization before checking delivery.`
        : `${phase} rejected. Your original message, uploaded file references, and options are saved in this browser.`
      : intent.status === "uncertain"
        ? `${phase} unconfirmed. Check the server before retrying; do not start another chat.`
        : intent.status === "accepted"
          ? "First message accepted; waiting for confirmation in chat history."
          : intent.phase === "create"
            ? "Creating chat…"
            : "Sending first message…";
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
          Open chat
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
          {retryState.state === "loading" ? "Checking…" : "Check and retry"}
        </Button>
      ) : null}
      {!navigator.locks &&
      (intent.status === "rejected" || intent.status === "uncertain") ? (
        <span>Safe retry requires a browser with Web Locks support.</span>
      ) : null}
      {intent.status === "rejected" || intent.status === "uncertain" ? (
        <details className="w-full min-w-0">
          <summary className="cursor-pointer underline">
            Review saved message
          </summary>
          <p className="mt-1 whitespace-pre-wrap break-words">{savedText}</p>
          {filenames.length > 0 ? (
            <p className="mt-1 break-words">
              Uploaded files: {filenames.join(", ")}
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
          aria-label="New chat delivery recovery"
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
