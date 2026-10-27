import { spawnSync } from "node:child_process";

import { Command, InvalidArgumentError, Option } from "commander";
import {
  browserWindowContextSchema,
  type BrowserSession,
  type BrowserWindowContext,
} from "@okouai/api-contracts/contracts/browser";
import { array, boolean, literal, number, object, string, url } from "zod";

import { getCurrentBrowser } from "../../lib/api/domains/browser";
import { isOkouBrowserSharedOwnerEnabled } from "../../lib/okou-env";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  readBrowserAttachment,
  saveBrowserAttachment,
  type BrowserAttachment,
} from "./browser-attachment";
import { BrowserCdpClient } from "./browser-cdp";

export const DEFAULT_AGENT_BROWSER_SESSION = "okou-browser";
const tabIdSchema = string().regex(/^t[1-9]\d*$/u);
const tabListSchema = object({
  success: literal(true),
  data: object({
    tabs: array(
      object({
        tabId: tabIdSchema,
        targetId: string().min(1),
        url: string(),
        active: boolean(),
      }),
    ),
  }),
});
const connectionSchema = object({
  success: literal(true),
  data: object({ cdpUrl: url({ protocol: /^wss?$/u }) }),
});
const nativeWindowSchema = object({
  windowId: number().int().nonnegative().safe(),
});
const targetInventorySchema = object({
  targetInfos: array(object({ targetId: string().min(1) })),
});

type DriverTab = {
  readonly tabId: string;
  readonly targetId: string;
  readonly url: string;
  readonly active: boolean;
};

type SafeTab = {
  readonly id: string;
  readonly origin: string;
  readonly active: boolean;
};

type TabOptions = {
  readonly agentSession?: string;
  readonly json?: boolean;
};

export function parseAgentSession(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(value)) {
    throw new InvalidArgumentError(
      "agent-session must contain only letters, numbers, underscores, or hyphens",
    );
  }
  return value;
}

function parseTabId(value: string): string {
  if (!tabIdSchema.safeParse(value).success) {
    throw new InvalidArgumentError("tab ID must be a current-session t<N> ID");
  }
  return value;
}

function runAgentBrowser(session: string, args: readonly string[]): string {
  // Both stdout and stderr can contain full URLs, OAuth parameters or titles.
  // Capture them without forwarding untrusted child output to the agent.
  const result = spawnSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      "Could not inspect the attached Browser tab; run `okou browser use` and retry.",
    );
  }
  return result.stdout;
}

function driverJson(session: string, args: readonly string[]): unknown {
  try {
    return JSON.parse(runAgentBrowser(session, args));
  } catch {
    throw new Error(
      "Could not inspect the attached Browser safely; run `okou browser use`.",
    );
  }
}

function windowContext(browser: BrowserSession): BrowserWindowContext | null {
  if (browser.window === undefined) {
    return null;
  }
  if (!isOkouBrowserSharedOwnerEnabled()) {
    throw new Error(
      "Shared Browser is not enabled for this Run; start a new Run",
    );
  }
  if (browser.status !== "active") {
    throw reconnectError();
  }
  const parsed = browserWindowContextSchema.safeParse(browser.window);
  if (!parsed.success) {
    throw new Error(
      "Browser window context is invalid; run `okou browser use`",
    );
  }
  return parsed.data;
}

function reconnectError(): Error {
  return new Error(
    "The attached Browser does not match this chat's current window; run `okou browser use`.",
  );
}

function verifyDriverConnection(session: string, cdpUrl: string): void {
  const connection = connectionSchema.safeParse(
    driverJson(session, ["get", "cdp-url", "--json"]),
  );
  if (
    !connection.success ||
    new URL(connection.data.data.cdpUrl).href !== new URL(cdpUrl).href
  ) {
    throw reconnectError();
  }
}

async function currentAttachment(
  session: string,
): Promise<BrowserAttachment | null> {
  const attachment = await readBrowserAttachment(session);
  if (!isOkouBrowserSharedOwnerEnabled()) {
    if (attachment) {
      throw reconnectError();
    }
    return null;
  }
  const browser = await getCurrentBrowser();
  const window = windowContext(browser);
  if (!window) {
    if (attachment) {
      throw reconnectError();
    }
    return null;
  }
  if (
    !attachment ||
    attachment.threadId !== browser.threadId ||
    attachment.window.instanceId !== window.instanceId ||
    attachment.window.primaryWindowId !== window.primaryWindowId
  ) {
    throw reconnectError();
  }
  verifyDriverConnection(session, attachment.cdpUrl);
  return attachment;
}

class BrowserWindowLookupError extends Error {}

async function windowConnection(cdpUrl: string): Promise<BrowserCdpClient> {
  return await BrowserCdpClient.connect(
    cdpUrl,
    Date.now() + 30_000,
    {
      connection: (message) => {
        return new Error(message);
      },
      timeout: (message) => {
        return new Error(message);
      },
      command: () => {
        return new BrowserWindowLookupError(
          "Could not resolve the Browser tab's native window",
        );
      },
    },
    1024 * 1024,
  );
}

async function nativeWindow(
  client: BrowserCdpClient,
  targetId: string,
): Promise<number | null> {
  let result: unknown;
  try {
    result = await client.send("Browser.getWindowForTarget", { targetId });
  } catch (error) {
    if (error instanceof BrowserWindowLookupError) {
      // Native error messages vary across Chrome versions. Confirm a missing
      // reference against Chrome instead of hiding provider/permission failures.
      const inventory = targetInventorySchema.safeParse(
        await client.send("Target.getTargets"),
      );
      if (!inventory.success) {
        throw new Error("The Browser returned incompatible target information");
      }
      if (
        !inventory.data.targetInfos.some((target) => {
          return target.targetId === targetId;
        })
      ) {
        return null;
      }
    }
    throw error;
  }
  const parsed = nativeWindowSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error(
      "The Browser returned incompatible native window information",
    );
  }
  return parsed.data.windowId;
}

async function tabsInWindow(
  client: BrowserCdpClient,
  tabs: readonly DriverTab[],
  window: BrowserWindowContext,
): Promise<readonly DriverTab[]> {
  const owned: DriverTab[] = [];
  for (const tab of tabs) {
    if ((await nativeWindow(client, tab.targetId)) === window.primaryWindowId) {
      owned.push(tab);
    }
  }
  return owned;
}

async function selectWindowTab(
  client: BrowserCdpClient,
  session: string,
  target: DriverTab,
  window: BrowserWindowContext,
): Promise<DriverTab> {
  if (
    (await nativeWindow(client, target.targetId)) !== window.primaryWindowId
  ) {
    throw new Error("This tab is not in this chat's current Browser window");
  }
  runAgentBrowser(session, ["--pin-tab", "tab", target.targetId]);
  const selected = driverTabs(session).find((tab) => {
    return tab.targetId === target.targetId && tab.active;
  });
  if (
    !selected ||
    (await nativeWindow(client, target.targetId)) !== window.primaryWindowId
  ) {
    throw new Error(
      "Browser tab selection changed; inspect this chat's tabs again",
    );
  }
  return selected;
}

export async function bindBrowserWindow(
  browser: BrowserSession,
  cdpUrl: string,
  session: string,
): Promise<void> {
  const window = windowContext(browser);
  if (!window) {
    return;
  }
  verifyDriverConnection(session, cdpUrl);
  const client = await windowConnection(cdpUrl);
  try {
    const tabs = await tabsInWindow(client, driverTabs(session), window);
    const target =
      tabs.find((tab) => {
        return tab.active;
      }) ?? tabs[0];
    if (!target) {
      throw new Error(
        "This chat's Browser window has no available tab; reconnect explicitly",
      );
    }
    await selectWindowTab(client, session, target, window);
    await saveBrowserAttachment(session, {
      threadId: browser.threadId,
      window,
      cdpUrl,
    });
  } finally {
    client.close();
  }
}

function safeOrigin(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : "non-web";
  } catch {
    return "unknown";
  }
}

function driverTabs(session: string): readonly DriverTab[] {
  const list = tabListSchema.safeParse(
    driverJson(session, ["tab", "list", "--json"]),
  );
  if (!list.success) {
    throw new Error(
      "Could not read Browser tabs safely; retry after `okou browser use`.",
    );
  }
  return list.data.data.tabs;
}

function safeTab(tab: DriverTab): SafeTab {
  return { id: tab.tabId, origin: safeOrigin(tab.url), active: tab.active };
}

function printTabs(
  tabs: readonly DriverTab[],
  json: boolean,
  window: BrowserWindowContext | null,
): void {
  const safe = tabs.map(safeTab);
  if (json) {
    console.log(JSON.stringify({ tabs: safe, ...(window ? { window } : {}) }));
    return;
  }
  if (window) {
    console.log(`Chat Browser window: ${window.primaryWindowId}`);
  }
  if (tabs.length === 0) {
    console.log("No Browser tabs found.");
    return;
  }
  for (const tab of safe) {
    console.log(`${tab.id}${tab.active ? " (selected)" : ""} ${tab.origin}`);
  }
}

const agentSessionOption = new Option(
  "--agent-session <name>",
  "Attached agent-browser session",
);

function tabSession(options: TabOptions): string {
  return options.agentSession === undefined
    ? DEFAULT_AGENT_BROWSER_SESSION
    : parseAgentSession(options.agentSession);
}

const listCommand = new Command()
  .name("list")
  .description(
    "Show tab IDs, origins and selection without full URLs or titles",
  )
  .addOption(agentSessionOption)
  .option("--json", "Print safe machine-readable tab metadata")
  .action(
    withErrorHandler(async (options: TabOptions) => {
      const session = tabSession(options);
      const attachment = await currentAttachment(session);
      const tabs = driverTabs(session);
      if (!attachment) {
        printTabs(tabs, options.json === true, null);
        return;
      }
      const client = await windowConnection(attachment.cdpUrl);
      try {
        printTabs(
          await tabsInWindow(client, tabs, attachment.window),
          options.json === true,
          attachment.window,
        );
      } finally {
        client.close();
      }
    }),
  );

const selectCommand = new Command()
  .name("select")
  .description("Select a current-session tab without printing its URL or title")
  .argument("<tab-id>", "Tab ID from a fresh `okou browser tab list`")
  .addOption(agentSessionOption)
  .option("--json", "Print safe machine-readable selection metadata")
  .action(
    withErrorHandler(async (id: string, options: TabOptions) => {
      const session = tabSession(options);
      const parsedId = parseTabId(id);
      const attachment = await currentAttachment(session);
      let selected: DriverTab | undefined;
      if (attachment) {
        const target = driverTabs(session).find((tab) => {
          return tab.tabId === parsedId;
        });
        if (!target) {
          throw new Error(
            "This Browser tab is no longer available; inspect tabs again",
          );
        }
        const client = await windowConnection(attachment.cdpUrl);
        try {
          selected = await selectWindowTab(
            client,
            session,
            target,
            attachment.window,
          );
        } finally {
          client.close();
        }
      } else {
        runAgentBrowser(session, ["tab", parsedId]);
        selected = driverTabs(session).find((item) => {
          return item.tabId === parsedId && item.active;
        });
      }
      const tab = selected ? safeTab(selected) : undefined;
      if (!tab) {
        throw new Error(
          "Browser tab selection could not be verified; inspect tabs again.",
        );
      }
      if (options.json) {
        console.log(JSON.stringify({ tab }));
        return;
      }
      console.log(`Selected ${tab.id} ${tab.origin}`);
    }),
  );

export const browserTabCommand = new Command()
  .name("tab")
  .description(
    "Inspect and select existing tabs without exposing URLs or titles",
  )
  .addCommand(listCommand)
  .addCommand(selectCommand);
