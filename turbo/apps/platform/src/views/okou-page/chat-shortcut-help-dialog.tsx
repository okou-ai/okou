import { singleAgentEnabled$ } from "../../signals/single-agent.ts";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { activeRoute$ } from "../../signals/active-route.ts";
import type { RouteKey } from "../../signals/route-paths.ts";
import {
  chatShortcutHelpOpen$,
  setChatShortcutHelpOpen$,
} from "../../signals/chat-page/chat-shortcut-help.ts";
import { i18n } from "../../i18n/index.ts";
import { ShortcutHelpDialog } from "../components/shortcut-help-dialog.tsx";
import { COMPOSER_VOICE_INPUT_SHORTCUT } from "../../lib/composer-voice-input-shortcut.ts";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import {
  COLLAPSE_PROJECT_SHORTCUT,
  EXPAND_PROJECT_SHORTCUT,
} from "../../lib/project-fold-shortcuts.ts";
import { projectsEnabled$ } from "../../signals/projects/projects.ts";

type ShortcutLabelId =
  | "blurComposer"
  | "changeIcon"
  | "clearIcon"
  | "collapseProject"
  | "expandProject"
  | "movePinDown"
  | "movePinUp"
  | "newChat"
  | "nextAgent"
  | "nextThread"
  | "openFirstThread"
  | "previousAgent"
  | "previousThread"
  | "renameChat"
  | "scrollBottom"
  | "scrollTop"
  | "searchWorkspace"
  | "sendMessage"
  | "setIcon"
  | "showShortcuts"
  | "toggleSidebar"
  | "togglePin"
  | "unreadOnly"
  | "voiceInput";

interface ShortcutDefinition {
  readonly key: string;
  readonly labelId: ShortcutLabelId;
}

interface ShortcutSectionDefinition {
  readonly titleId: ShortcutSectionTitleId;
  readonly shortcuts: readonly ShortcutDefinition[];
}

type ShortcutSectionTitleId = "composer" | "global" | "messages" | "pinned";

const GLOBAL_NAVIGATION_SHORTCUTS = [
  { key: "shift+/", labelId: "showShortcuts" },
  {
    key: GLOBAL_KEYBOARD_SHORTCUTS.toggleChatList.binding,
    labelId: "toggleSidebar",
  },
  { key: GLOBAL_KEYBOARD_SHORTCUTS.newChat.binding, labelId: "newChat" },
  {
    key: GLOBAL_KEYBOARD_SHORTCUTS.searchWorkspace.binding,
    labelId: "searchWorkspace",
  },
  {
    key: GLOBAL_KEYBOARD_SHORTCUTS.toggleUnreadOnly.binding,
    labelId: "unreadOnly",
  },
  { key: "ctrl+shift+[", labelId: "previousAgent" },
  { key: "ctrl+shift+]", labelId: "nextAgent" },
] as const satisfies readonly ShortcutDefinition[];

const PROJECT_FOLD_SHORTCUTS = [
  { key: COLLAPSE_PROJECT_SHORTCUT, labelId: "collapseProject" },
  { key: EXPAND_PROJECT_SHORTCUT, labelId: "expandProject" },
] as const satisfies readonly ShortcutDefinition[];

const COMPOSER_SHORTCUT_SECTION = {
  titleId: "composer",
  shortcuts: [
    { key: "enter", labelId: "sendMessage" },
    { key: COMPOSER_VOICE_INPUT_SHORTCUT, labelId: "voiceInput" },
    { key: "escape", labelId: "blurComposer" },
  ],
} as const satisfies ShortcutSectionDefinition;

const PINNED_SHORTCUT_SECTION = {
  titleId: "pinned",
  shortcuts: [
    {
      key: GLOBAL_KEYBOARD_SHORTCUTS.moveChatPinUp.binding,
      labelId: "movePinUp",
    },
    {
      key: GLOBAL_KEYBOARD_SHORTCUTS.moveChatPinDown.binding,
      labelId: "movePinDown",
    },
  ],
} as const satisfies ShortcutSectionDefinition;

const CHAT_THREAD_SHORTCUT_SECTIONS = [
  {
    titleId: "global",
    shortcuts: [
      ...GLOBAL_NAVIGATION_SHORTCUTS,
      {
        key: GLOBAL_KEYBOARD_SHORTCUTS.renameChat.binding,
        labelId: "renameChat",
      },
      {
        key: GLOBAL_KEYBOARD_SHORTCUTS.toggleChatPin.binding,
        labelId: "togglePin",
      },
      { key: "shift+f2", labelId: "changeIcon" },
      { key: "ctrl+shift+1", labelId: "setIcon" },
      { key: "ctrl+shift+0", labelId: "clearIcon" },
    ],
  },
  {
    titleId: "messages",
    shortcuts: [
      { key: "mod+arrowup", labelId: "scrollTop" },
      { key: "mod+arrowdown", labelId: "scrollBottom" },
      { key: "mod+shift+arrowup", labelId: "previousThread" },
      { key: "mod+shift+arrowdown", labelId: "nextThread" },
      ...PROJECT_FOLD_SHORTCUTS,
    ],
  },
  PINNED_SHORTCUT_SECTION,
  COMPOSER_SHORTCUT_SECTION,
] as const satisfies readonly ShortcutSectionDefinition[];

const AGENT_CHAT_SHORTCUT_SECTIONS = [
  {
    titleId: "global",
    shortcuts: [
      ...GLOBAL_NAVIGATION_SHORTCUTS,
      { key: "mod+shift+arrowdown", labelId: "openFirstThread" },
    ],
  },
  PINNED_SHORTCUT_SECTION,
  COMPOSER_SHORTCUT_SECTION,
] as const satisfies readonly ShortcutSectionDefinition[];

const PROJECT_SHORTCUT_SECTIONS = [
  {
    titleId: "global",
    shortcuts: [...GLOBAL_NAVIGATION_SHORTCUTS, ...PROJECT_FOLD_SHORTCUTS],
  },
  PINNED_SHORTCUT_SECTION,
] as const satisfies readonly ShortcutSectionDefinition[];

const SIDEBAR_SHORTCUT_SECTIONS = [
  { titleId: "global", shortcuts: GLOBAL_NAVIGATION_SHORTCUTS },
  PINNED_SHORTCUT_SECTION,
] as const satisfies readonly ShortcutSectionDefinition[];

function shortcutSectionsForRoute(
  route: RouteKey | null,
): readonly ShortcutSectionDefinition[] {
  if (route === "chat") {
    return CHAT_THREAD_SHORTCUT_SECTIONS;
  }
  if (route === "agentChat" || route === "home") {
    return AGENT_CHAT_SHORTCUT_SECTIONS;
  }
  if (route === "project") {
    return PROJECT_SHORTCUT_SECTIONS;
  }
  return SIDEBAR_SHORTCUT_SECTIONS;
}

function translatedSectionTitles(): Readonly<
  Record<ShortcutSectionTitleId, string>
> {
  return {
    composer: i18n.t(($) => {
      return $.appShell.shortcutHelp.sections.composer;
    }),
    global: i18n.t(($) => {
      return $.appShell.shortcutHelp.sections.global;
    }),
    messages: i18n.t(($) => {
      return $.appShell.shortcutHelp.sections.messages;
    }),
    pinned: i18n.t(($) => {
      return $.chat.sidebar.pinned;
    }),
  };
}

function translatedShortcutLabels(): Readonly<Record<ShortcutLabelId, string>> {
  return {
    blurComposer: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.blurComposer;
    }),
    changeIcon: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.changeIcon;
    }),
    clearIcon: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.clearIcon;
    }),
    collapseProject: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.collapseProject;
    }),
    expandProject: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.expandProject;
    }),
    movePinDown: i18n.t(($) => {
      return $.chat.sidebar.movePinDown;
    }),
    movePinUp: i18n.t(($) => {
      return $.chat.sidebar.movePinUp;
    }),
    newChat: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.newChat;
    }),
    nextAgent: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.nextAgent;
    }),
    nextThread: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.nextThread;
    }),
    openFirstThread: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.openFirstThread;
    }),
    previousAgent: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.previousAgent;
    }),
    previousThread: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.previousThread;
    }),
    renameChat: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.renameChat;
    }),
    scrollBottom: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.scrollBottom;
    }),
    scrollTop: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.scrollTop;
    }),
    searchWorkspace: i18n.t(($) => {
      return $.appShell.sidebar.searchWorkspace;
    }),
    sendMessage: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.sendMessage;
    }),
    setIcon: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.setIcon;
    }),
    showShortcuts: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.showShortcuts;
    }),
    toggleSidebar: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.toggleSidebar;
    }),
    togglePin: i18n.t(($) => {
      return $.appShell.shortcutHelp.shortcuts.togglePin;
    }),
    unreadOnly: i18n.t(($) => {
      return $.chat.sidebar.unreadOnly;
    }),
    voiceInput: i18n.t(($) => {
      return $.chat.voice.input;
    }),
  };
}

function shortcutListed(
  labelId: ShortcutLabelId,
  { singleAgent, projects }: { singleAgent: boolean; projects: boolean },
): boolean {
  if (labelId === "previousAgent" || labelId === "nextAgent") {
    return !singleAgent;
  }
  if (labelId === "collapseProject" || labelId === "expandProject") {
    return projects;
  }
  return true;
}

function localizeShortcutSections(
  sections: readonly ShortcutSectionDefinition[],
  listing: { singleAgent: boolean; projects: boolean },
) {
  const sectionTitles = translatedSectionTitles();
  const shortcutLabels = translatedShortcutLabels();
  return sections.map((section) => {
    return {
      title: sectionTitles[section.titleId],
      shortcuts: section.shortcuts
        .filter((shortcut) => {
          return shortcutListed(shortcut.labelId, listing);
        })
        .map((shortcut) => {
          return {
            key: shortcut.key,
            label: shortcutLabels[shortcut.labelId],
          };
        }),
    };
  });
}

export function ChatShortcutHelpDialog() {
  const { t } = useTranslation();
  const singleAgent = useGet(singleAgentEnabled$);
  const projects = useGet(projectsEnabled$);
  const shortcutHelpOpen = useGet(chatShortcutHelpOpen$);
  const setShortcutHelpOpen = useSet(setChatShortcutHelpOpen$);
  const activeRoute = useGet(activeRoute$);
  const shortcutSections = localizeShortcutSections(
    shortcutSectionsForRoute(activeRoute),
    { singleAgent, projects },
  );

  return (
    <ShortcutHelpDialog
      open={shortcutHelpOpen}
      onOpenChange={setShortcutHelpOpen}
      description={t(($) => {
        return $.appShell.shortcutHelp.description;
      })}
      sections={shortcutSections}
    />
  );
}
