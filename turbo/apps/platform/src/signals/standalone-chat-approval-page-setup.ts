import { chatThreadMetadataContract } from "@okouai/api-contracts/client/chat-threads";
import { command } from "ccstate";
import { createElement, type ReactNode } from "react";
import { uuid } from "zod";
import { accept } from "../lib/accept.ts";
import { NotFoundPage } from "../views/not-found-page.tsx";
import { BankingActionCard } from "../views/okou-page/banking-action-card.tsx";
import { ConnectorAccountActionCard } from "../views/okou-page/connector-account-action-card.tsx";
import { apiClient$ } from "./api-client.ts";
import { hideAppSkeleton$ } from "./app-skeleton.ts";
import {
  createBankingSignals,
  parseBankingActionUrl,
} from "./chat-page/banking-action-block.ts";
import {
  createConnectorAccountActionSignals,
  parseConnectorAccountActionUrl,
} from "./chat-page/connector-account-action-block.ts";
import { updatePage$ } from "./react-router.ts";
import { pathname$, searchParams$ } from "./route.ts";

const loadApprovalCard$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<ReactNode> => {
    const path = get(pathname$);
    const params = get(searchParams$);
    const threadId = uuid().safeParse(params.get("threadId"));
    if (!threadId.success || params.getAll("threadId").length !== 1) {
      return null;
    }
    const thread = await accept(
      get(apiClient$)(chatThreadMetadataContract).get({
        params: { id: threadId.data },
        fetchOptions: { signal },
      }),
      [200, 404],
      signal,
    );
    if (thread.status === 404) {
      return null;
    }

    const href = `${path}?${params.toString()}`;
    const context = { threadId: thread.body.id };
    const banking = parseBankingActionUrl(href, context);
    if (banking.status === "valid") {
      const signals = createBankingSignals(banking.descriptor);
      set(signals.subscribe$, signal);
      return createElement(BankingActionCard, { signals });
    }
    const account = parseConnectorAccountActionUrl(href, context);
    return account.status === "valid"
      ? createElement(ConnectorAccountActionCard, {
          signals: createConnectorAccountActionSignals(account.descriptor),
        })
      : null;
  },
);

export const setupStandaloneChatApprovalPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    const card = await set(loadApprovalCard$, signal);
    signal.throwIfAborted();
    const page = card
      ? createElement(
          "main",
          { className: "mx-auto w-full max-w-xl p-6 pt-safe-offset-8" },
          card,
        )
      : createElement(NotFoundPage);
    set(updatePage$, page, "standalone");
    await set(hideAppSkeleton$, signal);
  },
);
