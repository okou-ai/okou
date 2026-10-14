import { useGet, useLastResolved } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, MessageCircle, Package, Plug, User } from "lucide-react";
import { cn } from "@okouai/ui";
import { activeRoute$ } from "../../signals/active-route.ts";
import { currentChatAgentId$ } from "../../signals/agent-chat.ts";
import { isChatRoute } from "../../signals/okou-page/nav.ts";
import { pwaHasUnreadChats$ } from "../../signals/okou-page/pwa-chat-list.ts";
import {
  isWorkflowDetailRouteKey,
  ROUTES,
  type RouteKey,
} from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";
import { AgentUnreadIndicator } from "./sidebar-agent-row-actions.tsx";

type PwaParentPathname =
  | typeof ROUTES.me
  | typeof ROUTES.agents
  | typeof ROUTES.workflows
  | typeof ROUTES.officialWorkflows;

function PwaBackLink({
  pathname,
  options,
  label,
}: {
  readonly pathname: Parameters<typeof Link>[0]["pathname"];
  readonly options?: Parameters<typeof Link>[0]["options"];
  readonly label: string;
}) {
  return (
    <Link
      pathname={pathname}
      options={options}
      aria-label={label}
      className="flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-state-hover"
    >
      <ArrowLeft className="size-5" />
    </Link>
  );
}

export function PwaBackToChats() {
  const { t } = useTranslation();
  const agentId = useLastResolved(currentChatAgentId$);
  return (
    <PwaBackLink
      pathname={agentId ? ROUTES.agentChat : ROUTES.home}
      options={agentId ? { pathParams: { agentId } } : undefined}
      label={t(($) => {
        return $.appShell.pwaNavigation.backToChats;
      })}
    />
  );
}

// Agents, Workflows and Works are opened from Me, so each page steps back one
// level toward it. Tab roots have no parent.
function pwaParentPathname(route: RouteKey | null): PwaParentPathname | null {
  if (route === "agents" || route === "workflows" || route === "works") {
    return ROUTES.me;
  }
  if (route === "agentDetail" || route === "agentPermissions") {
    return ROUTES.agents;
  }
  if (route === "officialWorkflows" || isWorkflowDetailRouteKey(route)) {
    return ROUTES.workflows;
  }
  if (route === "officialWorkflowDetail") {
    return ROUTES.officialWorkflows;
  }
  return null;
}

export function PwaBackToParent() {
  const { t } = useTranslation();
  const pathname = pwaParentPathname(useGet(activeRoute$));
  if (!pathname) {
    return null;
  }
  return (
    <PwaBackLink
      pathname={pathname}
      label={t(($) => {
        return $.appShell.pwaNavigation.back;
      })}
    />
  );
}

function PwaTabUnreadIndicator() {
  const hasUnreadChats = useLastResolved(pwaHasUnreadChats$);
  if (!hasUnreadChats) {
    return null;
  }
  // The background ring cuts the dot out of the icon stroke it overlaps.
  return (
    <span className="absolute -right-1 -top-1 flex rounded-full bg-background p-0.5">
      <AgentUnreadIndicator />
    </span>
  );
}

export function PwaBottomNavigation() {
  const { t } = useTranslation();
  const route = useGet(activeRoute$);
  const agentId = useLastResolved(currentChatAgentId$);
  const tabs = [
    {
      pathname: agentId ? ROUTES.agentChat : ROUTES.home,
      options: agentId ? { pathParams: { agentId } } : undefined,
      label: t(($) => {
        return $.appShell.pwaNavigation.chats;
      }),
      Icon: MessageCircle,
      filledPath: "M22 12a10 10 0 0 1-14.3 9L2 22l1-5.7A10 10 0 1 1 22 12Z",
      active: isChatRoute(route),
      unread: true,
    },
    {
      pathname: ROUTES.connectors,
      label: t(($) => {
        return $.appShell.sidebar.navigation.connectors;
      }),
      Icon: Plug,
      filledPath:
        "M7 2h2v6h6V2h2v6h2v5a7 7 0 0 1-6 6.93V23h-2v-3.07A7 7 0 0 1 5 13V8h2V2Z",
      active: route === "connectors",
      unread: false,
    },
    {
      pathname: ROUTES.artifacts,
      label: t(($) => {
        return $.appShell.sidebar.navigation.artifacts;
      }),
      Icon: Package,
      filledPath:
        "m12 2 10 5.5v9L12 22 2 16.5v-9L12 2Zm0 10.2L3.5 7.5l-.7 1.3 8.45 4.65v6.8h1.5v-6.8l8.45-4.65-.7-1.3-8.5 4.7Zm4.14-3.98-8-4.4-.72 1.31 8 4.4.72-1.31Z",
      active: route === "artifacts",
      unread: false,
    },
    {
      pathname: ROUTES.me,
      label: t(($) => {
        return $.appShell.pwaNavigation.me;
      }),
      Icon: User,
      filledPath:
        "M17 7A5 5 0 1 1 7 7a5 5 0 0 1 10 0ZM10 14h4a7 7 0 0 1 7 7v1H3v-1a7 7 0 0 1 7-7Z",
      active:
        !isChatRoute(route) && route !== "connectors" && route !== "artifacts",
      unread: false,
    },
  ];
  return (
    <nav
      aria-label={t(($) => {
        return $.appShell.pwaNavigation.navigation;
      })}
      className="grid shrink-0 grid-cols-4 gap-1 border-t border-border/50 bg-background px-2 pt-1 pb-safe [view-transition-name:pwa-tab-bar] [[data-keyboard-open=true]_&]:hidden"
    >
      {tabs.map(
        ({ pathname, options, label, Icon, filledPath, active, unread }) => {
          return (
            <Link
              key={pathname}
              pathname={pathname}
              options={options}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 text-xs font-medium transition-colors",
                active
                  ? "text-brand-text hover:text-brand-text-hover"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="relative flex">
                {active ? (
                  <svg
                    viewBox="0 0 24 24"
                    className="size-5 fill-current"
                    aria-hidden="true"
                  >
                    <path d={filledPath} fillRule="evenodd" />
                  </svg>
                ) : (
                  <Icon className="size-5" aria-hidden="true" />
                )}
                {unread && <PwaTabUnreadIndicator />}
              </span>
              <span className="max-w-full truncate">{label}</span>
            </Link>
          );
        },
      )}
    </nav>
  );
}
