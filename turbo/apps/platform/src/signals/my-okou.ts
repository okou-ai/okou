import { command, computed, state } from "ccstate";
import type { BrowserClerk } from "@clerk/shared/types";
import { object, string } from "zod";
import { instructionsContract } from "@okouai/api-contracts/client/instructions";
import type { InstructionsResponse } from "@okouai/api-contracts/contracts/instructions";
import { accept } from "../lib/accept.ts";
import { apiClient$ } from "./api-client.ts";
import { clerk$, authenticatedSessionKey$ } from "./auth.ts";
import { sessionStorageSignals } from "./external/session-storage.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../i18n/index.ts";
import { watchInstructionsUpdates$ } from "./instructions-updates.ts";

const draftSchema = object({
  content: string(),
  version: string(),
  savedContent: string(),
});

// Session storage retains drafts across navigation and Clerk workspace changes.
// Keys include both owners; neither the public executor ID nor the last page
// supplies ownership. A retained version still participates in stale-write checks.
function createPersonalInstructionsDraft(orgId: string, userId: string) {
  const storage = sessionStorageSignals(
    `instructions-draft:${orgId}:${userId}`,
  );
  const revision$ = state(0);
  const conflict$ = state(false);
  const draft$ = computed((get) => {
    const value = get(storage.get$);
    if (!value) {
      return null;
    }
    const draft = draftSchema.parse(JSON.parse(value));
    return draft.content === draft.savedContent ? null : draft;
  });
  const edit$ = command(
    ({ get, set }, content: string, saved: InstructionsResponse) => {
      const draft = get(draft$);
      if (content === (draft?.savedContent ?? saved.content)) {
        set(storage.clear$);
        set(conflict$, false);
        return;
      }
      set(
        storage.set$,
        JSON.stringify({
          content,
          version: draft?.version ?? saved.version,
          savedContent: draft?.savedContent ?? saved.content,
        }),
      );
    },
  );
  const discard$ = command(({ set }) => {
    set(storage.clear$);
    set(conflict$, false);
    set(revision$, (value) => {
      return value + 1;
    });
  });
  return { draft$, revision$, conflict$, edit$, discard$ };
}

function createMyOkouSignals(
  orgId: string,
  userId: string,
  clerk: Pick<BrowserClerk, "organization" | "user" | "session">,
  sessionId: string,
) {
  const draft = createPersonalInstructionsDraft(orgId, userId);
  const reload$ = state(0);
  const published$ = state<InstructionsResponse | null>(null);
  const client$ = computed((get) => {
    return get(apiClient$)(instructionsContract, {
      getTokenGuard: () => {
        const check = () => {
          if (
            clerk.organization?.id !== orgId ||
            clerk.user?.id !== userId ||
            clerk.session?.id !== sessionId
          ) {
            throw new Error("Instructions workspace changed");
          }
        };
        check();
        return check;
      },
    });
  });
  const saved$ = computed(async (get) => {
    get(reload$);
    const published = get(published$);
    if (published) {
      return published;
    }
    const response = await accept(get(client$).get(), [200]);
    return response.body;
  });
  const retry$ = command(({ set }) => {
    set(published$, null);
    set(reload$, (value) => {
      return value + 1;
    });
  });
  const watch$ = command(({ set }, signal: AbortSignal) => {
    set(
      watchInstructionsUpdates$,
      { scope: "user", topic: "personalInstructionsChanged", reload$: retry$ },
      signal,
    );
  });
  const reloadLatest$ = command(async ({ get, set }, signal: AbortSignal) => {
    const response = await accept(
      get(client$).get({ fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    set(published$, response.body);
    set(draft.discard$);
  });
  const save$ = command(async ({ get, set }, signal: AbortSignal) => {
    const edit = get(draft.draft$);
    if (!edit) {
      return;
    }
    signal.throwIfAborted();
    const response = await accept(
      get(client$).update({
        body: { content: edit.content, ifVersion: edit.version },
        fetchOptions: { signal },
      }),
      [200, 409],
    );
    signal.throwIfAborted();
    if (response.status === 409) {
      set(draft.conflict$, true);
      return;
    }
    set(published$, response.body);
    set(draft.discard$);
    toast.success(
      i18n.t(($) => {
        return $.myOkou.saved;
      }),
    );
  });
  return {
    saved$,
    ...draft,
    retry$,
    watch$,
    reloadLatest$,
    save$,
  };
}

export const myOkouSignals$ = computed(async (get) => {
  const sessionKey = get(authenticatedSessionKey$);
  // Clerk mutates organization in place; authenticatedIdentity$ can retain its
  // earlier snapshot. Re-read the live owners when the stable session key moves.
  const clerk = await get(clerk$);
  const orgId = clerk.organization?.id;
  const userId = clerk.user?.id;
  const sessionId = clerk.session?.id;
  if (!sessionKey || !orgId || !userId || !sessionId) {
    throw new Error("Instructions require an active workspace and member");
  }
  return createMyOkouSignals(orgId, userId, clerk, sessionId);
});

export type MyOkouSignals = ReturnType<typeof createMyOkouSignals>;
