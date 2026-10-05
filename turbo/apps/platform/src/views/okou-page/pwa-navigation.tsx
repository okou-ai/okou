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
      filledPath: "M22 12a10 10 0 0 1-14.3 9L2 22l1-5.7A10 10 0 1 1 22 12Z",
      active: isChatRoute(route),
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
    },
  ];
  return (
    <nav
      aria-label={t(($) => {
        return $.appShell.pwaNavigation.navigation;
      })}
      className="grid shrink-0 grid-cols-4 gap-1 border-t border-border/50 bg-background px-2 pt-1 pb-safe [[data-keyboard-open=true]_&]:hidden"
    >
      {tabs.map(({ pathname, options, label, Icon, filledPath, active }) => {
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
            <span className="max-w-full truncate">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
