import { command } from "ccstate";
import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { accept } from "../../lib/accept.ts";
import { ApiError } from "../../lib/api-error.ts";
import { i18n } from "../../i18n/index.ts";
import { apiClient$ } from "../api-client.ts";
import { onRejection, settle } from "../utils.ts";
import {
  sourcesFirstDraft$,
  updateSourcesFirstDraft$,
  type SourcesFirstInvite,
} from "./onboarding-sources-first-state.ts";

/**
 * The statuses the invitation route answers with a reason of its own — already
 * a member, already invited, no permission, plan inactive. Their message names
 * the address's actual problem, so it is shown as it arrived. Anything else,
 * including a server fault or a lost connection, only carries a status code.
 */
function explainsItself(status: number): boolean {
  return status === 400 || status === 403 || status === 409 || status === 503;
}

function failureMessage(error: unknown): string {
  if (error instanceof ApiError && explainsItself(error.status)) {
    return error.message;
  }
  return i18n.t(($) => {
    return $.onboarding.sourcesFirst.team.failed;
  });
}

/** Replaces the entry for this address, or appends it the first time. */
const recordInvite$ = command(({ get, set }, invite: SourcesFirstInvite) => {
  const { invites } = get(sourcesFirstDraft$);
  const known = invites.some((current) => {
    return current.email === invite.email;
  });
  set(updateSourcesFirstDraft$, {
    invites: known
      ? invites.map((current) => {
          return current.email === invite.email ? invite : current;
        })
      : [...invites, invite],
  });
});

const dropInvite$ = command(({ get, set }, email: string) => {
  set(updateSourcesFirstDraft$, {
    invites: get(sourcesFirstDraft$).invites.filter((current) => {
      return current.email !== email;
    }),
  });
});

/** An address already in flight or already accepted is not sent again. */
export function sourcesFirstInviteSendable(
  invites: readonly SourcesFirstInvite[],
  email: string,
): boolean {
  if (email === "") {
    return false;
  }
  return invites.every((invite) => {
    return invite.email !== email || invite.status === "failed";
  });
}

/**
 * Sends one workspace invitation and keeps beside the address whatever the API
 * answered. A member without a usage pack is the whole request, which keeps
 * onboarding clear of the seat-purchase preview and confirm branch.
 *
 * The step is optional, so a refused address is shown where it was typed
 * rather than raised at the flow: nothing here can hold someone back.
 */
export const sendSourcesFirstInvite$ = command(
  async ({ get, set }, email: string, signal: AbortSignal): Promise<void> => {
    const address = email.trim();
    if (!sourcesFirstInviteSendable(get(sourcesFirstDraft$).invites, address)) {
      return;
    }
    set(recordInvite$, { email: address, status: "pending", failure: null });
    const client = get(apiClient$)(orgInviteContract);
    const invitation = accept(
      client.invite({
        body: { email: address, role: "member" },
        fetchOptions: { signal },
      }),
      [200],
      signal,
      // The address carries its own outcome; a toast would only repeat it.
      { showErrorToast: false },
    );
    const answer = await onRejection(settle(invitation, signal), () => {
      // Only cancellation gets here: leaving the step aborted the request
      // before its answer was read. Drop the entry rather than report an
      // outcome this browser never saw; typing the address again asks the API
      // for a fresh one.
      set(dropInvite$, address);
    });
    signal.throwIfAborted();
    set(
      recordInvite$,
      answer.ok
        ? { email: address, status: "invited", failure: null }
        : {
            email: address,
            status: "failed",
            failure: failureMessage(answer.error),
          },
    );
  },
);
