import { computed } from "ccstate";
import type { RoutePath } from "../route-paths";
import { isWorkflowDetailRouteKey, ROUTES } from "../route-paths.ts";
import { pathParams$, type RouterPathParams } from "../route.ts";
import { activeRoute$ } from "../active-route.ts";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { currentWorkflowDetail$ } from "../workflows-page/workflows-signals.ts";
import { i18n } from "../../i18n/index.ts";
import { locale$ } from "../locale.ts";
import { assistantName$ } from "../branding.ts";

interface MobileBreadcrumb {
  section: string;
  sectionPath?: RoutePath;
  sectionOptions?: {
    pathParams?: RouterPathParams;
    searchParams?: URLSearchParams;
  };
  name?: string;
}

type Params = Record<string, unknown> | null;

function getStringParam(params: Params, key: string): string | null {
  if (params && key in params) {
    return String(params[key]);
  }
  return null;
}

const CHAT_PATH = "/" as RoutePath;

const activityDetailBreadcrumb$ = computed(
  async (get): Promise<MobileBreadcrumb | null> => {
    get(locale$);
    const section = i18n.t(($) => {
      return $.activity.detail.activity;
    });
    const features = await get(featureSwitches$);
    if (!features?.[FeatureSwitchKey.OkouDebug]) {
      return null;
    }
    return { section };
  },
);

const workflowsBreadcrumb$ = computed(
  async (get): Promise<MobileBreadcrumb> => {
    get(locale$);
    const section = i18n.t(($) => {
      return $.appShell.sidebar.navigation.workflows;
    });
    const params = get(pathParams$) as Params;
    const workflowId = getStringParam(params, "workflowId");
    if (workflowId) {
      const detail = await get(currentWorkflowDetail$);
      if (detail) {
        return {
          section,
          sectionPath: ROUTES.workflows,
          name: detail.displayName ?? detail.name,
        };
      }
    }
    return {
      section,
      sectionPath: ROUTES.workflows,
    };
  },
);

const chatBreadcrumb$ = computed((get): MobileBreadcrumb => ({
  section: get(assistantName$),
  sectionPath: CHAT_PATH,
}));

/**
 * Provides breadcrumb data for the MobileTopBar.
 * For chat: resolves the active agent name and avatar.
 * For activity/team detail pages: derives a sub-page name from signals.
 * For other sections: returns a static label so the top bar has context on mobile
 * (page-level breadcrumbs use `hidden md:flex` and are invisible on mobile).
 */
export const mobileBreadcrumb$ = computed(
  async (get): Promise<MobileBreadcrumb | null> => {
    get(locale$);
    const route = get(activeRoute$);

    if (route === "workflows" || isWorkflowDetailRouteKey(route)) {
      return await get(workflowsBreadcrumb$);
    }

    if (route === "activityDetail") {
      return await get(activityDetailBreadcrumb$);
    }

    if (route === "works") {
      return {
        section: i18n.t(
          ($) => {
            return $.appShell.sidebar.navigation.works;
          },
          { agentName: get(assistantName$) },
        ),
        sectionPath: ROUTES.works,
      };
    }

    // Static labels for other non-chat sections
    const nonChatSections: Partial<
      Record<string, { label: string; path: RoutePath }>
    > = {
      forYou: {
        label: i18n.t(($) => {
          return $.chat.agentSuggestions.forYou.title;
        }),
        path: ROUTES.forYou,
      },
      settings: {
        label: i18n.t(($) => {
          return $.appShell.sidebar.navigation.settings;
        }),
        path: ROUTES.settings,
      },
      connectors: {
        label: i18n.t(($) => {
          return $.appShell.sidebar.navigation.connectors;
        }),
        path: ROUTES.connectors,
      },
    };
    if (route) {
      const nonChatSection = nonChatSections[route];
      if (nonChatSection) {
        return {
          section: nonChatSection.label,
          sectionPath: nonChatSection.path,
        };
      }
    }

    // Chat-related routes
    if (route !== "home" && route !== "chat") {
      return null;
    }

    return await get(chatBreadcrumb$);
  },
);
