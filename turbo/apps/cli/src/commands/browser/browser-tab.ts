import { spawnSync } from "node:child_process";

import { Command, InvalidArgumentError, Option } from "commander";
import type { BrowserSession } from "@okouai/api-contracts/contracts/browser";
import { array, boolean, literal, number, object, string } from "zod";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import { BrowserCdpClient } from "./browser-cdp";

export const DEFAULT_AGENT_BROWSER_SESSION = "okou-browser";
const WINDOW_LOOKUP_CONCURRENCY = 4;
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

export async function bindBrowserWindow(
  browser: BrowserSession,
  cdpUrl: string,
  session: string,
): Promise<void> {
  const window = browser.window;
  if (!window) {
    return;
  }
  const client = await windowConnection(cdpUrl);
  try {
    const tabs = [...driverTabs(session)].sort((left, right) => {
      return Number(right.active) - Number(left.active);
    });
    let lookupFailure: BrowserWindowLookupError | undefined;
    for (let offset = 0; offset < tabs.length;) {
      // A selected member remains a one-command fast path. Other candidates
      // are checked in driver order, independent of their response order.
      const count =
        offset === 0 && tabs[0]?.active ? 1 : WINDOW_LOOKUP_CONCURRENCY;
      const batch = tabs.slice(offset, offset + count);
      const results = await Promise.allSettled(
        batch.map((target) => {
          return nativeWindow(client, target.targetId);
        }),
      );
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          const error: unknown = result.reason;
          if (!(error instanceof BrowserWindowLookupError)) {
            throw error;
          }
          lookupFailure ??= error;
          continue;
        }
        if (result.value !== window.primaryWindowId) {
          continue;
        }
        const target = batch[index]!;
        // A candidate can move while another lookup in its batch completes.
        if (
          batch.length > 1 &&
          (await nativeWindow(client, target.targetId)) !==
            window.primaryWindowId
        ) {
          throw new Error(
            "The Browser tab moved or closed before attachment; run `okou browser use` again",
          );
        }
        runAgentBrowser(session, ["--pin-tab", "tab", target.targetId]);
        return;
      }
      offset += count;
    }
    throw (
      lookupFailure ??
      new Error(
        "This chat's Browser window has no available tab; reconnect explicitly",
      )
    );
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

function printTabs(tabs: readonly DriverTab[], json: boolean): void {
  const safe = tabs.map(safeTab);
  if (json) {
    console.log(JSON.stringify({ tabs: safe }));
    return;
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
      printTabs(driverTabs(session), options.json === true);
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
      runAgentBrowser(session, ["tab", parsedId]);
      const selected = driverTabs(session).find((item) => {
        return item.tabId === parsedId && item.active;
      });
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
