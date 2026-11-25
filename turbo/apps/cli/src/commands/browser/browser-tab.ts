import { spawnSync } from "node:child_process";

import { Command, InvalidArgumentError } from "commander";
import { array, boolean, literal, object, string } from "zod";

import { withErrorHandler } from "../../lib/command/with-error-handler";

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
  readonly json?: boolean;
};

function parseTabId(value: string): string {
  if (!tabIdSchema.safeParse(value).success) {
    throw new InvalidArgumentError("tab ID must be a current-session t<N> ID");
  }
  return value;
}

function runAgentBrowser(args: readonly string[]): string {
  // Both stdout and stderr can contain full URLs, OAuth parameters or titles.
  // Capture them without forwarding untrusted child output to the agent.
  const result = spawnSync(
    "agent-browser",
    ["--session", DEFAULT_AGENT_BROWSER_SESSION, ...args],
    {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      "Could not inspect the attached Browser tab; run `okou browser use` and retry.",
    );
  }
  return result.stdout;
}

function driverJson(args: readonly string[]): unknown {
  try {
    return JSON.parse(runAgentBrowser(args));
  } catch {
    throw new Error(
      "Could not inspect the attached Browser safely; run `okou browser use`.",
    );
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

function driverTabs(): readonly DriverTab[] {
  const list = tabListSchema.safeParse(driverJson(["tab", "list", "--json"]));
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

const listCommand = new Command()
  .name("list")
  .description(
    "Show tab IDs, origins and selection without full URLs or titles",
  )
  .option("--json", "Print safe machine-readable tab metadata")
  .action(
    withErrorHandler(async (options: TabOptions) => {
      printTabs(driverTabs(), options.json === true);
    }),
  );

const selectCommand = new Command()
  .name("select")
  .description("Select a current-session tab without printing its URL or title")
  .argument("<tab-id>", "Tab ID from a fresh `okou browser tab list`")
  .option("--json", "Print safe machine-readable selection metadata")
  .action(
    withErrorHandler(async (id: string, options: TabOptions) => {
      const parsedId = parseTabId(id);
      runAgentBrowser(["tab", parsedId]);
      const selected = driverTabs().find((item) => {
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
