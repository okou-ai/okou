import { command, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { clerk$, clerkUser$, openClerkAddAccount$ } from "./auth.ts";
import { replaceSearchParams$, searchParams$ } from "./route.ts";
import { jsonParseOr, onDomEventFn } from "./utils.ts";
import { i18n } from "../i18n/index.ts";

const CLERK_STATUS_PARAM = "__clerk_status";
const CLERK_TICKET_PARAM = "__clerk_ticket";
const INVITATION_ACTION_CLASS_NAMES = {
  actionButton: "underline-offset-4 hover:underline active:opacity-80",
} as const;
const INVITATION_ACTION_STYLE = {
  background: "transparent",
  color: "hsl(var(--primary))",
  fontSize: "inherit",
  height: "auto",
  lineHeight: "1.5",
  padding: 0,
} as const;

interface InvitationRedirect {
  readonly organizationId: string;
}

const internalInvitationRedirect$ = state<InvitationRedirect | null>(null);

function organizationIdFromTicket(ticket: string): string | null {
  const parts = ticket.split(".");
  const encodedPayload = parts.length === 3 ? parts[1] : undefined;
  if (!encodedPayload) {
    return null;
  }
  if (
    !/^[A-Za-z0-9_-]+$/u.test(encodedPayload) ||
    encodedPayload.length % 4 === 1
  ) {
    return null;
  }

  const base64Payload = encodedPayload
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(encodedPayload.length / 4) * 4, "=");

  const payload = jsonParseOr<unknown>(atob(base64Payload), null);
  if (
    payload !== null &&
    typeof payload === "object" &&
    "st" in payload &&
    payload.st === "organization_invitation" &&
    "oid" in payload &&
    typeof payload.oid === "string" &&
    payload.oid.length > 0
  ) {
    return payload.oid;
  }

  return null;
}

/**
 * Capture a completed Clerk organization-invitation redirect before route
 * analytics run, retaining only the target organization ID needed for UI.
 */
export const captureInvitationRedirect$ = command(({ get, set }) => {
  const searchParams = new URLSearchParams(get(searchParams$));
  if (searchParams.get(CLERK_STATUS_PARAM) !== "complete") {
    return;
  }

  const ticket = searchParams.get(CLERK_TICKET_PARAM);
  searchParams.delete(CLERK_STATUS_PARAM);
  searchParams.delete(CLERK_TICKET_PARAM);
  set(replaceSearchParams$, searchParams, {}, location.hash);

  if (!ticket) {
    return;
  }

  const organizationId = organizationIdFromTicket(ticket);
  if (organizationId) {
    set(internalInvitationRedirect$, { organizationId });
  }
});

export const handleInvitationRedirect$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const redirect = get(internalInvitationRedirect$);
    set(internalInvitationRedirect$, null);
    if (!redirect) {
      return;
    }

    const clerk = await get(clerk$);
    signal.throwIfAborted();

    // The ticket payload only identifies the target. Current Clerk membership
    // is the authoritative signal that the active account accepted the invite.
    const user = await get(clerkUser$);
    signal.throwIfAborted();

    const membership = user?.organizationMemberships.find((item) => {
      return item.organization.id === redirect.organizationId;
    });

    if (membership) {
      const title = i18n.t(
        ($) => {
          return $.invitationRedirect.success.title;
        },
        { workspace: membership.organization.name },
      );

      if (clerk.organization?.id === redirect.organizationId) {
        toast.success(title);
        return;
      }

      toast.success(title, {
        actionButtonStyle: INVITATION_ACTION_STYLE,
        classNames: INVITATION_ACTION_CLASS_NAMES,
        action: {
          label: i18n.t(($) => {
            return $.invitationRedirect.actions.switchWorkspace;
          }),
          onClick: onDomEventFn(async () => {
            await clerk.setActive({ organization: redirect.organizationId });
          }),
        },
      });
      return;
    }

    toast.success(
      i18n.t(($) => {
        return $.invitationRedirect.accountMismatch.title;
      }),
      {
        actionButtonStyle: INVITATION_ACTION_STYLE,
        classNames: INVITATION_ACTION_CLASS_NAMES,
        action: {
          label: i18n.t(($) => {
            return $.invitationRedirect.actions.switchAccount;
          }),
          onClick: onDomEventFn(async () => {
            await set(openClerkAddAccount$, signal);
          }),
        },
      },
    );
  },
);
