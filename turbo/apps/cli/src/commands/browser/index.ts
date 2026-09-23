import { spawnSync } from "node:child_process";

import chalk from "chalk";
import { Command, InvalidArgumentError, Option } from "commander";
import {
  BROWSER_IDLE_LEASE_MINUTES,
  browserCreateRequestSchema,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import {
  BROWSER_USER_ACTION_MAX_CALLBACK_PROMPT_LENGTH,
  BROWSER_USER_ACTION_MAX_DESCRIPTION_LENGTH,
  BROWSER_USER_ACTION_MAX_FIELDS,
  BROWSER_USER_ACTION_MAX_KEY_LENGTH,
  BROWSER_USER_ACTION_MAX_LABEL_LENGTH,
  browserUserActionCreateRequestSchema,
  browserUserActionFieldKindSchema,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { z } from "zod";

import {
  createBrowser,
  createBrowserUserAction,
  getCurrentBrowser,
  leaseBrowser,
  type BrowserUserActionCreateResponse,
  useBrowser,
} from "../../lib/api/domains/browser";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { captureBrowserInputTargets } from "./browser-user-action-capture";

const DEFAULT_AGENT_BROWSER_SESSION = "okou-browser";
const BROWSER_INPUT_TARGET_MAX_LENGTH = 2048;
const BROWSER_ACTION_NEXT_STEP =
  "Return this exact action URL in your final response, then stop using the Browser in this turn.";

const browserInputFieldOptionSchema = z
  .object({
    key: z.string().trim().min(1).max(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
    label: z.string().trim().min(1).max(BROWSER_USER_ACTION_MAX_LABEL_LENGTH),
    description: z
      .string()
      .trim()
      .max(BROWSER_USER_ACTION_MAX_DESCRIPTION_LENGTH)
      .optional(),
    fieldKind: browserUserActionFieldKindSchema,
    required: z.boolean(),
    target: z.string().trim().min(1).max(BROWSER_INPUT_TARGET_MAX_LENGTH),
  })
  .strict();

const browserInputFieldsOptionSchema = z
  .array(browserInputFieldOptionSchema)
  .min(1)
  .max(BROWSER_USER_ACTION_MAX_FIELDS)
  .superRefine((fields, context) => {
    const keys = new Set<string>();
    for (const [index, field] of fields.entries()) {
      if (keys.has(field.key)) {
        context.addIssue({
          code: "custom",
          message: "Browser input field keys must be unique",
          path: [index, "key"],
        });
      }
      keys.add(field.key);
    }
  });

type BrowserInputFieldOption = z.infer<typeof browserInputFieldOptionSchema>;

interface NewOptions {
  readonly name: string;
  readonly country?: string;
  readonly agentSession?: string;
  readonly json?: boolean;
}

interface ConnectionOptions {
  readonly agentSession?: string;
  readonly json?: boolean;
}

interface OutputOptions {
  readonly json?: boolean;
}

interface InputRequestOptions extends OutputOptions {
  readonly agentSession?: string;
  readonly callbackPrompt: string;
  readonly field: readonly string[];
}

interface InteractionRequestOptions extends OutputOptions {
  readonly callbackPrompt: string;
  readonly reason: string;
}

function parseCountry(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z]{2}$/u.test(normalized)) {
    throw new InvalidArgumentError("country must be a two-letter country code");
  }
  return normalized;
}

function parseAgentSession(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(value)) {
    throw new InvalidArgumentError(
      "agent-session must contain only letters, numbers, underscores, or hyphens",
    );
  }
  return value;
}

function collectInputField(
  value: string,
  previous: readonly string[],
): readonly string[] {
  return [...previous, value];
}

function parseInputFields(
  values: readonly string[],
): readonly BrowserInputFieldOption[] {
  const decoded: unknown[] = [];
  for (const value of values) {
    try {
      decoded.push(JSON.parse(value));
    } catch {
      throw new Error("A --field value must be valid JSON");
    }
  }
  const fields = browserInputFieldsOptionSchema.safeParse(decoded);
  if (!fields.success) {
    throw new Error(
      fields.error.issues[0]?.message ?? "Browser input fields are invalid",
    );
  }
  return fields.data;
}

function invalidRequest(message: string): Error {
  return new Error(message);
}

function renderBrowserUserAction(
  response: BrowserUserActionCreateResponse,
  options: OutputOptions,
): void {
  if (options.json) {
    console.log(
      JSON.stringify({
        actionUrl: response.actionUrl,
        nextAction: BROWSER_ACTION_NEXT_STEP,
      }),
    );
    return;
  }
  console.log(chalk.green("✓ Browser handoff ready"));
  console.log(response.actionUrl);
  console.log(chalk.dim(BROWSER_ACTION_NEXT_STEP));
}

function browserJson(browser: BrowserSession): Omit<BrowserSession, "liveUrl"> {
  const { liveUrl: _liveUrl, ...safeBrowser } = browser;
  return safeBrowser;
}

function connectAgentBrowser(cdpUrl: string, sessionName: string): void {
  const result = spawnSync(
    "agent-browser",
    ["--session", sessionName, "connect", cdpUrl],
    { stdio: "ignore" },
  );
  if (result.error) {
    throw new Error("Could not start agent-browser", {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `agent-browser connect exited with status ${result.status ?? "unknown"}`,
    );
  }
}

function reclaimNotice(browser: BrowserSession): string {
  return browser.idleExpiresAt
    ? `Okou reclaims this browser at ${browser.idleExpiresAt} unless it is used or leased again`
    : "This browser has no live window to reclaim";
}

function renderBrowser(browser: BrowserSession): void {
  console.log(`${browser.name} · ${browser.status}`);
  console.log(chalk.dim(`  Thread ID: ${browser.threadId}`));
  console.log(chalk.dim(`  ${reclaimNotice(browser)}`));
  console.log(`  ${browser.viewerUrl}`);
}

async function connectResponse(
  response: {
    readonly browser: BrowserSession;
    readonly cdpUrl: string;
  },
  options: ConnectionOptions,
): Promise<void> {
  const sessionName = options.agentSession ?? DEFAULT_AGENT_BROWSER_SESSION;
  connectAgentBrowser(response.cdpUrl, sessionName);
  if (options.json) {
    console.log(
      JSON.stringify({
        browser: browserJson(response.browser),
        agentBrowserSession: sessionName,
      }),
    );
    return;
  }
  console.log(chalk.green("✓ Managed browser ready"));
  console.log(chalk.dim(`  agent-browser session: ${sessionName}`));
  console.log(chalk.dim(`  ${reclaimNotice(response.browser)}`));
  console.log(`[Open live browser](${response.browser.viewerUrl})`);
}

const useCommand = new Command()
  .name("use")
  .description(
    "Create, reuse, or resume this thread's browser, attach it to agent-browser, and extend its lease",
  )
  .addOption(
    new Option(
      "--agent-session <name>",
      "Named agent-browser session",
    ).argParser(parseAgentSession),
  )
  .option("--json", "Print machine-readable output without connection secrets")
  .action(
    withErrorHandler(async (options: ConnectionOptions) => {
      await connectResponse(await useBrowser(), options);
    }),
  );

const leaseCommand = new Command()
  .name("lease")
  .description(
    `Keep this thread's live browser for another ${BROWSER_IDLE_LEASE_MINUTES} minutes`,
  )
  .option("--json", "Print machine-readable output")
  .action(
    withErrorHandler(async (options: OutputOptions) => {
      const browser = await leaseBrowser();
      if (options.json) {
        console.log(JSON.stringify({ browser: browserJson(browser) }));
        return;
      }
      console.log(chalk.green("✓ Managed browser lease extended"));
      console.log(chalk.dim(`  ${reclaimNotice(browser)}`));
    }),
  );

const newCommand = new Command()
  .name("new")
  .description(
    "Create another thread browser with an isolated profile and attach it to agent-browser",
  )
  .addOption(new Option("--name <name>", "Browser name").default("browser"))
  .addOption(
    new Option(
      "--country <code>",
      "Residential proxy country; omitted uses lower-cost proxyless egress",
    ).argParser(parseCountry),
  )
  .addOption(
    new Option(
      "--agent-session <name>",
      "Named agent-browser session",
    ).argParser(parseAgentSession),
  )
  .option("--json", "Print machine-readable output without connection secrets")
  .action(
    withErrorHandler(async (options: NewOptions) => {
      const request = browserCreateRequestSchema.parse({
        name: options.name,
        proxyCountryCode: options.country ?? null,
      });
      await connectResponse(await createBrowser(request), options);
    }),
  );

const statusCommand = new Command()
  .name("status")
  .description("Show the current thread browser status")
  .option("--json", "Print machine-readable output")
  .action(
    withErrorHandler(async (options: OutputOptions) => {
      const browser = await getCurrentBrowser();
      if (options.json) {
        console.log(JSON.stringify({ browser: browserJson(browser) }));
        return;
      }
      renderBrowser(browser);
    }),
  );

const viewCommand = new Command()
  .name("view")
  .description("Print the current thread browser's authenticated viewer link")
  .action(
    withErrorHandler(async () => {
      console.log((await getCurrentBrowser()).viewerUrl);
    }),
  );

const inputRequestCommand = new Command()
  .name("input-request")
  .description(
    "Create a native Okou form for exact controls in the attached Browser",
  )
  .requiredOption(
    "--callback-prompt <text>",
    "Message that starts the next agent round after values are applied",
  )
  .option(
    "--field <json>",
    "Field metadata and local target; repeat for every field",
    collectInputField,
    [] as string[],
  )
  .addOption(
    new Option(
      "--agent-session <name>",
      "Attached agent-browser session",
    ).argParser(parseAgentSession),
  )
  .option("--json", "Print machine-readable output")
  .action(
    withErrorHandler(async (options: InputRequestOptions) => {
      const fields = parseInputFields(options.field);
      if (
        options.callbackPrompt.trim().length === 0 ||
        options.callbackPrompt.trim().length >
          BROWSER_USER_ACTION_MAX_CALLBACK_PROMPT_LENGTH
      ) {
        throw invalidRequest("callback prompt is invalid");
      }
      const captured = await captureBrowserInputTargets(
        options.agentSession ?? DEFAULT_AGENT_BROWSER_SESSION,
        fields.map((field) => {
          return field.target;
        }),
      );
      const request = browserUserActionCreateRequestSchema.safeParse({
        kind: "input",
        callbackPrompt: options.callbackPrompt,
        pageTargetId: captured.pageTargetId,
        fields: fields.map((field, index) => {
          const backendNodeId = captured.backendNodeIds[index];
          if (backendNodeId === undefined) {
            throw invalidRequest("A Browser field target was not captured");
          }
          return {
            key: field.key,
            label: field.label,
            ...(field.description === undefined
              ? {}
              : { description: field.description }),
            fieldKind: field.fieldKind,
            required: field.required,
            backendNodeId,
          };
        }),
      });
      if (!request.success) {
        throw invalidRequest("Browser input request metadata is invalid");
      }
      renderBrowserUserAction(
        await createBrowserUserAction(request.data),
        options,
      );
    }),
  );

const interactionRequestCommand = new Command()
  .name("interaction-request")
  .description(
    "Hand the current thread Browser to the user for direct interaction",
  )
  .requiredOption(
    "--reason <text>",
    "User-facing reason that direct Browser interaction is required",
  )
  .requiredOption(
    "--callback-prompt <text>",
    "Message that starts the next agent round after the user finishes",
  )
  .option("--json", "Print machine-readable output")
  .action(
    withErrorHandler(async (options: InteractionRequestOptions) => {
      const request = browserUserActionCreateRequestSchema.safeParse({
        kind: "direct_interaction",
        reason: options.reason,
        callbackPrompt: options.callbackPrompt,
      });
      if (!request.success) {
        throw invalidRequest(
          request.error.issues[0]?.message ??
            "Browser interaction request is invalid",
        );
      }
      renderBrowserUserAction(
        await createBrowserUserAction(request.data),
        options,
      );
    }),
  );

export const browserCommand = new Command()
  .name("browser")
  .description("Use a managed remote browser through agent-browser")
  .addCommand(useCommand)
  .addCommand(leaseCommand)
  .addCommand(newCommand)
  .addCommand(statusCommand)
  .addCommand(viewCommand)
  .addCommand(inputRequestCommand)
  .addCommand(interactionRequestCommand)
  .addHelpText(
    "after",
    `
Examples:
  Open this thread's browser: okou browser use
  Keep it alive:              okou browser lease
  Create another browser:     okou browser new --name booking --country us
  Use the browser:            agent-browser --session ${DEFAULT_AGENT_BROWSER_SESSION} open https://example.com
  Share live view:            okou browser view
  Request native input:       okou browser input-request --field '{"key":"username","label":"Email","fieldKind":"username","required":true,"target":"@e1"}' --callback-prompt "Continue after the user enters their email"
  Request direct interaction: okou browser interaction-request --reason "Complete the passkey prompt" --callback-prompt "Continue after the user completes the passkey prompt"

Notes:
  - The browser outlives this run; the user can keep working in it from the viewer link
  - Okou reclaims it after ${BROWSER_IDLE_LEASE_MINUTES} idle minutes
  - \`okou browser use\` restores a reclaimed browser's login profile and reopens saved tab URLs when possible
  - Browser Use credentials and connection URLs are never printed
  - Each thread keeps an isolated login profile
  - Threads can run their browsers in parallel
  - Input selectors and refs are resolved locally and are never sent to the API
  - Resolving an @eN ref focuses it but never types, clicks, or submits the website form
  - After either request command succeeds, return its exact URL and run no later Browser command in this turn`,
  );
