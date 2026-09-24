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
import { ApiRequestError } from "../../lib/api/core/client-factory";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { captureBrowserInputTargets } from "./browser-user-action-capture";
import { BrowserInputRequestError } from "./browser-input-request-error";

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
  readonly callbackPrompt?: string;
  readonly field: readonly string[];
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
  for (const [index, value] of values.entries()) {
    try {
      decoded.push(JSON.parse(value));
    } catch {
      throw new BrowserInputRequestError(
        "BROWSER_INPUT_INVALID_FIELD",
        `--field ${index + 1} must be valid JSON`,
        `Correct --field ${index + 1} and rerun input-request.`,
      );
    }
  }
  const fields = browserInputFieldsOptionSchema.safeParse(decoded);
  if (!fields.success) {
    const issue = fields.error.issues[0];
    const index = issue?.path[0];
    const property = issue?.path[1];
    const position = typeof index === "number" ? index + 1 : null;
    const location = position === null ? "--field" : `--field ${position}`;
    const reason =
      property === "key"
        ? issue?.code === "custom"
          ? "key must be unique"
          : `key must be 1-${BROWSER_USER_ACTION_MAX_KEY_LENGTH} characters`
        : property === "label"
          ? `label must be 1-${BROWSER_USER_ACTION_MAX_LABEL_LENGTH} characters`
          : property === "description"
            ? `description must be at most ${BROWSER_USER_ACTION_MAX_DESCRIPTION_LENGTH} characters`
            : property === "fieldKind"
              ? `fieldKind must be ${browserUserActionFieldKindSchema.options.join(", ")}`
              : property === "required"
                ? "required must be true or false"
                : property === "target"
                  ? `target must be 1-${BROWSER_INPUT_TARGET_MAX_LENGTH} characters`
                  : `provide 1-${BROWSER_USER_ACTION_MAX_FIELDS} fields with only supported properties`;
    throw new BrowserInputRequestError(
      "BROWSER_INPUT_INVALID_FIELD",
      `${location}: ${reason}`,
      position === null
        ? "Correct the --field options and rerun input-request."
        : `Correct --field ${position} and rerun input-request.`,
    );
  }
  return fields.data;
}

function invalidRequest(message: string): BrowserInputRequestError {
  return new BrowserInputRequestError(
    "BROWSER_INPUT_INVALID_REQUEST",
    message,
    "Correct the command options and rerun input-request.",
  );
}

function apiInputRequestError(
  error: ApiRequestError,
): BrowserInputRequestError {
  const code = /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.code)
    ? error.code
    : "BROWSER_INPUT_API_ERROR";
  if (code === "UNAUTHORIZED") {
    return new BrowserInputRequestError(
      code,
      "The run token is missing, invalid, or expired",
      "Start a current Okou chat run with a valid run token.",
    );
  }
  if (code === "FORBIDDEN") {
    return new BrowserInputRequestError(
      code,
      "Browser native input is not enabled or this run is not allowed to use it",
      "Use direct Browser takeover or ask the team to enable native input for this account.",
    );
  }
  if (code === "BROWSER_USER_ACTION_RUN_REQUIRED") {
    return new BrowserInputRequestError(
      code,
      error.message,
      "Create the request during an active chat agent run.",
    );
  }
  if (code === "BAD_REQUEST") {
    return new BrowserInputRequestError(
      code,
      "The Browser input request was rejected before creation",
      "Use a current run token and check the command options.",
    );
  }
  if (code === "BROWSER_USER_ACTION_NOT_FOUND") {
    return new BrowserInputRequestError(
      code,
      "The active run or Browser changed before the request was saved",
      "Inspect the current Browser in an active chat run and create a new request.",
    );
  }
  if (code === "BROWSER_USER_ACTION_BROWSER_NOT_LIVE") {
    return new BrowserInputRequestError(
      code,
      error.message,
      "Run `okou browser use`, inspect the live page, then capture the controls again.",
    );
  }
  if (
    code === "BROWSER_USER_ACTION_PAGE_TARGET_NOT_FOUND" ||
    code === "BROWSER_USER_ACTION_BACKEND_NODE_NOT_FOUND"
  ) {
    return new BrowserInputRequestError(
      code,
      error.message,
      "Inspect the current Browser page and recapture the changed target.",
    );
  }
  if (code === "BROWSER_USER_ACTION_UNSUPPORTED_PAGE") {
    return new BrowserInputRequestError(
      code,
      error.message,
      "Open an HTTP or HTTPS page in the Browser and recapture its controls, or hand the Browser to the user.",
    );
  }
  if (code === "BROWSER_USER_ACTION_UNSUPPORTED_CONTROL") {
    return new BrowserInputRequestError(
      code,
      error.message,
      "Choose a supported control and matching fieldKind, or hand the Browser to the user.",
    );
  }
  if (code === "BROWSER_USE_TIMEOUT" || code === "BROWSER_USE_CAPACITY") {
    return new BrowserInputRequestError(
      code,
      code === "BROWSER_USE_TIMEOUT"
        ? "The managed Browser inspection timed out"
        : "Managed Browser capacity is temporarily unavailable",
      "Check that the Browser is live, then retry this request once.",
      true,
    );
  }
  if (code === "BROWSER_USE_AUTH_ERROR") {
    return new BrowserInputRequestError(
      code,
      "Managed Browser provider authentication failed",
      "Stop this request and ask the Okou team to check the Browser provider.",
    );
  }
  if (code === "BROWSER_USE_NOT_CONFIGURED") {
    return new BrowserInputRequestError(
      code,
      "Managed Browser access is not configured",
      "Stop this request and ask the Okou team to configure managed Browser access.",
    );
  }
  if (code === "BROWSER_USE_OUTPUT_TOO_LARGE") {
    return new BrowserInputRequestError(
      code,
      "The managed Browser provider response exceeded the supported size",
      "Stop this request and ask the Okou team to inspect the Browser provider response.",
    );
  }
  if (
    code === "BROWSER_USE_ERROR" ||
    code === "BROWSER_USER_ACTION_PROVIDER_ERROR"
  ) {
    return new BrowserInputRequestError(
      code,
      "The managed Browser could not complete target validation",
      "Check the Browser status; ask the Okou team for help if it remains unavailable.",
    );
  }
  return new BrowserInputRequestError(
    code,
    `Browser input request failed (HTTP ${error.status})`,
    "Inspect the error code and current Browser state before trying again.",
  );
}

function renderInputRequestError(
  error: unknown,
  options: InputRequestOptions,
): boolean {
  const failure =
    error instanceof BrowserInputRequestError
      ? error
      : error instanceof ApiRequestError
        ? apiInputRequestError(error)
        : new BrowserInputRequestError(
            "BROWSER_INPUT_REQUEST_FAILED",
            "Browser input request failed unexpectedly",
            "Inspect the Browser state or ask the Okou team for help.",
          );
  if (options.json) {
    console.error(
      JSON.stringify({
        error: {
          code: failure.code,
          message: failure.message,
          nextAction: failure.nextAction,
          retryable: failure.retryable,
        },
      }),
    );
  } else {
    console.error(chalk.red(`✗ ${failure.code}: ${failure.message}`));
    console.error(chalk.dim(`  Next: ${failure.nextAction}`));
  }
  return true;
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
  .option(
    "--callback-prompt <text>",
    "Required message that starts the next agent round after values are applied",
  )
  .option(
    "--field <json>",
    "Field metadata and local target; repeat for every field",
    collectInputField,
    [] as string[],
  )
  .addOption(
    new Option("--agent-session <name>", "Attached agent-browser session"),
  )
  .option("--json", "Print machine-readable output")
  .action(
    withErrorHandler(async (options: InputRequestOptions) => {
      const fields = parseInputFields(options.field);
      if (
        options.agentSession !== undefined &&
        !/^[a-zA-Z0-9_-]{1,64}$/u.test(options.agentSession)
      ) {
        throw invalidRequest(
          "--agent-session must contain 1-64 letters, numbers, underscores, or hyphens",
        );
      }
      const callbackPrompt = options.callbackPrompt ?? "";
      if (
        callbackPrompt.trim().length === 0 ||
        callbackPrompt.trim().length >
          BROWSER_USER_ACTION_MAX_CALLBACK_PROMPT_LENGTH
      ) {
        throw invalidRequest(
          `--callback-prompt must be 1-${BROWSER_USER_ACTION_MAX_CALLBACK_PROMPT_LENGTH} characters`,
        );
      }
      const captured = await captureBrowserInputTargets(
        options.agentSession ?? DEFAULT_AGENT_BROWSER_SESSION,
        fields.map((field) => {
          return field.target;
        }),
      );
      const request = browserUserActionCreateRequestSchema.safeParse({
        kind: "input",
        callbackPrompt,
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
        throw invalidRequest(
          "Captured Browser input request metadata is invalid",
        );
      }
      renderBrowserUserAction(
        await createBrowserUserAction(request.data),
        options,
      );
    }, renderInputRequestError),
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
  Request a number:           okou browser input-request --field '{"key":"quantity","label":"Quantity","fieldKind":"number","required":false,"target":"@e2"}' --callback-prompt "Continue after the user enters a quantity"

Notes:
  - The browser outlives this run; the user can keep working in it from the viewer link
  - Okou reclaims it after ${BROWSER_IDLE_LEASE_MINUTES} idle minutes
  - \`okou browser use\` restores a reclaimed browser's login profile and reopens saved tab URLs when possible
  - Browser Use credentials and connection URLs are never printed
  - Each thread keeps an isolated login profile
  - Threads can run their browsers in parallel
  - Input selectors and refs are resolved locally and are never sent to the API
  - Resolving an @eN ref focuses it but never types, clicks, or submits the website form
  - input-request failures identify a safe error code, affected --field position when known, and next action
  - input-request --json errors are one JSON object on stderr and exit nonzero
  - After input-request succeeds, return its exact URL and run no later Browser command in this turn
  - To hand the Browser to the user, return the exact okou browser view URL, explain the step, ask for a chat reply when finished or blocked, and stop using the Browser in this turn`,
  );
