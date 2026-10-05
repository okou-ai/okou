import { useGet, useLastResolved } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, MessageCircle, Package, Plug, User } from "lucide-react";
import { cn } from "@okouai/ui";
import { activeRoute$ } from "../../signals/active-route.ts";
import { currentChatAgentId$ } from "../../signals/agent-chat.ts";
import { isChatRoute } from "../../signals/okou-page/nav.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";

export function PwaBackToChats() {
  const { t } = useTranslation();
  const agentId = useLastResolved(currentChatAgentId$);
  return (
    <Link
      pathname={agentId ? ROUTES.agentChat : ROUTES.home}
      options={agentId ? { pathParams: { agentId } } : undefined}
      aria-label={t(($) => {
        return $.appShell.pwaNavigation.backToChats;
      })}
      className="flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-state-hover"
    >
      <ArrowLeft className="size-5" />
    </Link>
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
      active: isChatRoute(route),
    },
    {
      pathname: ROUTES.connectors,
      label: t(($) => {
        return $.appShell.sidebar.navigation.connectors;
      }),
      Icon: Plug,
      active: route === "connectors",
    },
    {
      pathname: ROUTES.artifacts,
      label: t(($) => {
        return $.appShell.sidebar.navigation.artifacts;
      }),
      Icon: Package,
      active: route === "artifacts",
    },
    {
      pathname: ROUTES.me,
      label: t(($) => {
        return $.appShell.pwaNavigation.me;
      }),
      Icon: User,
      active:
        !isChatRoute(route) && route !== "connectors" && route !== "artifacts",
    },
  ];
  return (
    <nav
      aria-label={t(($) => {
        return $.appShell.pwaNavigation.navigation;
      })}
      className="grid shrink-0 grid-cols-4 gap-1 border-t border-border/50 bg-background px-2 pt-1 pb-safe [[data-keyboard-open=true]_&]:hidden"
    >
      {tabs.map(({ pathname, options, label, Icon, active }) => {
        return (
          <Link
            key={pathname}
            pathname={pathname}
            options={options}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 text-xs font-medium transition-colors hover:bg-state-hover",
              active
                ? "bg-state-selected text-foreground"
                : "text-muted-foreground",
            )}
          >
            <Icon className="size-5" aria-hidden="true" />
            <span className="max-w-full truncate">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
