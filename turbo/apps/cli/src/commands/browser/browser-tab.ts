import { spawnSync } from "node:child_process";

import { Command, InvalidArgumentError, Option } from "commander";
import { z } from "zod";

import { withErrorHandler } from "../../lib/command/with-error-handler";

export const DEFAULT_AGENT_BROWSER_SESSION = "okou-browser";
const tabIdSchema = z.string().regex(/^t[1-9]\d*$/u);
const tabListSchema = z.object({
  success: z.literal(true),
  data: z.object({
    tabs: z.array(
      z.object({
        tabId: tabIdSchema,
        url: z.string(),
        active: z.boolean(),
      }),
    ),
  }),
});

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

function listTabs(session: string): readonly SafeTab[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(runAgentBrowser(session, ["tab", "list", "--json"]));
  } catch {
    throw new Error(
      "Could not read Browser tabs safely; retry after `okou browser use`.",
    );
  }
  const list = tabListSchema.safeParse(parsed);
  if (!list.success) {
    throw new Error(
      "Could not read Browser tabs safely; retry after `okou browser use`.",
    );
  }
  return list.data.data.tabs.map((tab) => {
    return { id: tab.tabId, origin: safeOrigin(tab.url), active: tab.active };
  });
}

function printTabs(tabs: readonly SafeTab[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ tabs }));
    return;
  }
  if (tabs.length === 0) {
    console.log("No Browser tabs found.");
    return;
  }
  for (const tab of tabs) {
    console.log(`${tab.id}${tab.active ? " (selected)" : ""} ${tab.origin}`);
  }
}

const agentSessionOption = new Option(
  "--agent-session <name>",
  "Attached agent-browser session",
).argParser(parseAgentSession);

const listCommand = new Command()
  .name("list")
  .description(
    "Show tab IDs, origins and selection without full URLs or titles",
  )
  .addOption(agentSessionOption)
  .option("--json", "Print safe machine-readable tab metadata")
  .action(
    withErrorHandler(async (options: TabOptions) => {
      printTabs(
        listTabs(options.agentSession ?? DEFAULT_AGENT_BROWSER_SESSION),
        options.json === true,
      );
    }),
  );

const selectCommand = new Command()
  .name("select")
  .description("Select a current-session tab without printing its URL or title")
  .argument(
    "<tab-id>",
    "Tab ID from a fresh `okou browser tab list`",
    parseTabId,
  )
  .addOption(agentSessionOption)
  .option("--json", "Print safe machine-readable selection metadata")
  .action(
    withErrorHandler(async (id: string, options: TabOptions) => {
      const session = options.agentSession ?? DEFAULT_AGENT_BROWSER_SESSION;
      runAgentBrowser(session, ["tab", id]);
      const tab = listTabs(session).find((item) => {
        return item.id === id && item.active;
      });
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
