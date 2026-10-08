import { join } from "node:path";
import { Command } from "commander";
import type {
  ComputerUseCommandResponse,
  ComputerUseReadCommandKind,
  ComputerUseWriteCommandKind,
} from "@okouai/api-contracts/contracts/computer-use";
import { ApiRequestError } from "../../lib/api/core/client-factory";
import {
  createComputerUseReadCommand,
  createComputerUseWriteCommand,
  fetchComputerUseScreenshot,
  getComputerUseCommand,
} from "../../lib/api/domains/computer-use";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  computerUseOutputDir,
  writeComputerUseArtifact,
} from "./output-artifacts";

interface ComputerUseCommandOptions {
  readonly timeout?: string;
}

interface ComputerUseAppOptions extends ComputerUseCommandOptions {
  readonly app: string;
}

interface ComputerUseClickOptions extends ComputerUseAppOptions {
  readonly snapshotId?: string;
  readonly element?: string;
  readonly elementIndex?: string;
  readonly x?: string;
  readonly y?: string;
  readonly button?: "left" | "right" | "middle";
  readonly clickCount?: string;
}

interface ComputerUseScrollOptions extends ComputerUseAppOptions {
  readonly snapshotId?: string;
  readonly element?: string;
  readonly elementIndex?: string;
  readonly direction: "up" | "down" | "left" | "right";
  readonly pages?: string;
}

interface ComputerUseSetValueOptions extends ComputerUseAppOptions {
  readonly snapshotId?: string;
  readonly element?: string;
  readonly elementIndex?: string;
  readonly value: string;
}

interface ComputerUsePerformActionOptions extends ComputerUseAppOptions {
  readonly snapshotId?: string;
  readonly element?: string;
  readonly elementIndex?: string;
  readonly action: string;
}

interface ComputerUseTypeTextOptions extends ComputerUseAppOptions {
  readonly snapshotId?: string;
  readonly text: string;
}

interface ComputerUsePressKeyOptions extends ComputerUseAppOptions {
  readonly snapshotId?: string;
  readonly key: string;
}

const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/s;
const COMPUTER_USE_REQUIRED_CAPABILITY_MESSAGE =
  "Missing required capability: computer-use:write";
const COMPUTER_USE_AUTHORIZATION_REQUIRED_ERROR =
  "COMPUTER_USE_AUTHORIZATION_REQUIRED";
const COMPUTER_USE_HELP_TEXT = `
Workflow:
  1. Start the Okou Desktop app and make sure Computer Use is online.
  2. Run "okou computer-use list-apps" to find the target app's bundleId.
     --app accepts a bundle id only (e.g. com.google.Chrome); the name is for
     display. Apps listed without a bundleId cannot be targeted.
  3. Run "okou computer-use get-app-state --app <bundleId>" to get a screenshot,
     snapshotId, visible element indexes, and accessibility state.
  4. Prefer element actions with --snapshot-id and --element-index. Use --x/--y
     only when the target is visible in the returned screenshot but has no useful
     accessibility element.
  5. Read the JSON result. Screenshot and App State data are saved under
     /tmp/okou/computer-use and replaced with local file paths in CLI output.
     Files are named from app and snapshotId; rerunning the same snapshot
     overwrites the same files.

Notes:
  Write commands are sent to the connected Desktop host. Coordinate fallbacks use
  screenshot coordinates from get-app-state; pass the matching --snapshot-id when
  acting on a prior snapshot.
  type-text sends literal keyboard input to the target app's current focus. It
  first verifies the focused element is editable and fails with
  element_not_editable when it is not (for example a focused table or list), so
  click into a text field before typing. Use set-value when you need
  deterministic accessibility value assignment.
  press-key accepts xdotool-style names such as shift+semicolon, Control_L+J,
  ctrl+alt+n, and BackSpace, plus existing macOS-style forms such as Command+L.
  type-text and press-key accept the same --snapshot-id as the element actions:
  pass it to deliver keyboard input to that snapshot's window. Without it, the
  most relevant window for the app is picked, which is ambiguous for multi-window
  apps.

Examples:
  List available apps:
    okou computer-use list-apps

  Inspect Safari state:
    okou computer-use get-app-state --app com.apple.Safari

  Click element index 7 from snapshot desktop_abc:
    okou computer-use click --app com.apple.Safari --snapshot-id desktop_abc --element-index 7

  Click screenshot coordinate (320, 240) from snapshot desktop_abc:
    okou computer-use click --app com.apple.Safari --snapshot-id desktop_abc --x 320 --y 240

  Type text into the snapshot desktop_abc window in Safari:
    okou computer-use type-text --app com.apple.Safari --snapshot-id desktop_abc --text "Hello"

  Press a keyboard shortcut in the snapshot desktop_abc window:
    okou computer-use press-key --app com.apple.Safari --snapshot-id desktop_abc --key shift+semicolon

  Open an app without activating the current foreground app:
    okou computer-use open-app --app com.culturedcode.ThingsMac`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function throwComputerUseAuthorizationGuidanceError(error: unknown): never {
  if (
    error instanceof ApiRequestError &&
    error.status === 403 &&
    error.code === "FORBIDDEN" &&
    error.message === COMPUTER_USE_REQUIRED_CAPABILITY_MESSAGE
  ) {
    throw new ApiRequestError(
      "Computer Use authorization required",
      COMPUTER_USE_AUTHORIZATION_REQUIRED_ERROR,
      403,
    );
  }

  throw error;
}

function parseTimeoutSeconds(value: string | undefined): number {
  if (!value) return 30;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Timeout must be a positive number of seconds");
  }
  return seconds;
}

function parseOptionalNonNegativeInteger(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function parsePositiveInteger(
  value: string | undefined,
  label: string,
): number {
  if (value === undefined) {
    throw new Error(`${label} is required`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parsePositiveNumber(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

function parseMouseButton(
  value: string | undefined,
): "left" | "right" | "middle" {
  if (value === "left" || value === "right" || value === "middle") {
    return value;
  }
  throw new Error("button must be left, right, or middle");
}

function elementTargetPayload(options: {
  readonly element?: string;
  readonly elementIndex?: string;
}): { readonly elementId?: string; readonly elementIndex?: number } {
  const elementIndex = parseOptionalNonNegativeInteger(
    options.elementIndex,
    "element-index",
  );
  if (!options.element && elementIndex === undefined) {
    throw new Error("element or element-index is required");
  }
  return {
    ...(options.element ? { elementId: options.element } : {}),
    ...(elementIndex !== undefined ? { elementIndex } : {}),
  };
}

function sanitizeFilenamePart(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized.length > 0 ? sanitized : fallback;
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/png") {
    return "png";
  }
  if (mimeType === "image/jpeg") {
    return "jpg";
  }
  if (mimeType === "image/webp") {
    return "webp";
  }
  const suffix = mimeType.startsWith("image/") ? mimeType.slice(6) : "bin";
  return sanitizeFilenamePart(suffix, "bin").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

async function writeScreenshotDataUrl(
  result: Record<string, unknown>,
  dataUrl: string,
): Promise<string | null> {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match) {
    return null;
  }

  const mimeType = match[1] ?? "";
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Unsupported screenshot MIME type: ${mimeType}`);
  }

  const base64Data = match[2] ?? "";
  const appName = sanitizeFilenamePart(result.app, "app");
  const snapshotId = sanitizeFilenamePart(result.snapshotId, "snapshot");
  const outputPath = join(
    computerUseOutputDir(),
    `${appName}-${snapshotId}.${extensionForMimeType(mimeType)}`,
  );

  await writeComputerUseArtifact(outputPath, Buffer.from(base64Data, "base64"));
  return outputPath;
}

function screenshotPointerType(value: unknown): "s3" | "expired" | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const type = (value as { readonly type?: unknown }).type;
  return type === "s3" || type === "expired" ? type : null;
}

async function writeScreenshotBytes(
  result: Record<string, unknown>,
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  const appName = sanitizeFilenamePart(result.app, "app");
  const snapshotId = sanitizeFilenamePart(result.snapshotId, "snapshot");
  const outputPath = join(
    computerUseOutputDir(),
    `${appName}-${snapshotId}.${extensionForMimeType(mimeType)}`,
  );

  await writeComputerUseArtifact(outputPath, buffer);
  return outputPath;
}

async function writeAppStateText(
  result: Record<string, unknown>,
  appState: string,
): Promise<string> {
  const appName = sanitizeFilenamePart(result.app, "app");
  const snapshotId = sanitizeFilenamePart(result.snapshotId, "snapshot");
  const outputPath = join(
    computerUseOutputDir(),
    `${appName}-${snapshotId}.appState.txt`,
  );

  await writeComputerUseArtifact(outputPath, appState);
  return outputPath;
}

function compactActionResult(
  action: Record<string, unknown>,
): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(action)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      compact[key] = value;
    }
  }
  return compact;
}

export async function formatComputerUseResultForConsole(
  result: Record<string, unknown>,
  commandId: string,
): Promise<string> {
  const printable: Record<string, unknown> = { status: "succeeded" };
  const apps = result.apps;
  if (Array.isArray(apps)) {
    printable.apps = apps;
  }
  const snapshotId = stringField(result, "snapshotId");
  if (snapshotId) {
    printable.snapshotId = snapshotId;
  }
  const appState = stringField(result, "appState");
  if (appState) {
    printable.appState = await writeAppStateText(result, appState);
  }
  const screenshot = result.screenshot;
  if (typeof screenshot === "string") {
    const screenshotPath = await writeScreenshotDataUrl(result, screenshot);
    printable.screenshot = screenshotPath ?? screenshot;
  } else {
    const pointerType = screenshotPointerType(screenshot);
    if (pointerType === "s3") {
      const { buffer, mimeType } = await fetchComputerUseScreenshot(commandId);
      printable.screenshot = await writeScreenshotBytes(
        result,
        buffer,
        mimeType,
      );
    } else if (pointerType === "expired") {
      printable.screenshot = "[screenshot expired]";
    }
  }
  const action = result.action;
  if (isRecord(action)) {
    printable.action = compactActionResult(action);
  }
  return JSON.stringify(printable, null, 2);
}

async function commandOutputText(
  command: ComputerUseCommandResponse,
): Promise<string> {
  if (!command.result) {
    return "";
  }
  return await formatComputerUseResultForConsole(command.result, command.id);
}

async function waitForCommand(
  commandId: string,
  timeoutSeconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    const command = await getComputerUseCommand(commandId);
    if (command.status === "queued" || command.status === "running") {
      if (process.stdout.isTTY) {
        process.stdout.write(".");
      }
      await sleep(500);
      continue;
    }

    if (process.stdout.isTTY) {
      process.stdout.write("\n");
    }

    if (command.status === "failed") {
      throw new Error(
        command.error
          ? `${command.error.code}: ${command.error.message}`
          : "Computer-use command failed",
      );
    }

    const text = await commandOutputText(command);
    if (text) {
      console.log(text);
    }
    return;
  }

  throw new Error(`Computer-use command timed out: ${commandId}`);
}

async function runReadCommand(
  kind: ComputerUseReadCommandKind,
  options: ComputerUseCommandOptions,
  payload: { readonly app?: string } = {},
): Promise<void> {
  const timeoutSeconds = parseTimeoutSeconds(options.timeout);
  try {
    const created = await createComputerUseReadCommand({
      kind,
      timeoutMs: timeoutSeconds * 1000,
      ...payload,
    });
    await waitForCommand(created.commandId, timeoutSeconds);
  } catch (error) {
    throwComputerUseAuthorizationGuidanceError(error);
  }
}

async function runWriteCommand(
  kind: ComputerUseWriteCommandKind,
  options: ComputerUseCommandOptions,
  payload: {
    readonly app: string;
    readonly snapshotId?: string;
    readonly elementId?: string;
    readonly elementIndex?: number;
    readonly x?: number;
    readonly y?: number;
    readonly button?: "left" | "right" | "middle";
    readonly clickCount?: number;
    readonly direction?: "up" | "down" | "left" | "right";
    readonly pages?: number;
    readonly value?: string;
    readonly text?: string;
    readonly key?: string;
    readonly action?: string;
  },
): Promise<void> {
  const timeoutSeconds = parseTimeoutSeconds(options.timeout);
  try {
    const created = await createComputerUseWriteCommand({
      kind,
      timeoutMs: timeoutSeconds * 1000,
      ...payload,
    });
    await waitForCommand(created.commandId, timeoutSeconds);
  } catch (error) {
    throwComputerUseAuthorizationGuidanceError(error);
  }
}

function addTargetOptions(command: Command): Command {
  return command.option("--timeout <seconds>", "Maximum time to wait", "30");
}

function appOption(command: Command): Command {
  return command.requiredOption(
    "--app <bundleId>",
    "Target app bundle id (e.g. com.google.Chrome); run list-apps to find it",
  );
}

const listAppsCommand = addTargetOptions(
  new Command()
    .name("list-apps")
    .description("List apps available to the Desktop Computer Use host")
    .action(
      withErrorHandler(async (options: ComputerUseCommandOptions) => {
        await runReadCommand("apps.list", options);
      }),
    ),
);

const getAppStateCommand = appOption(
  addTargetOptions(
    new Command()
      .name("get-app-state")
      .description(
        "Get screenshot and accessibility state without activating an app",
      )
      .action(
        withErrorHandler(async (options: ComputerUseAppOptions) => {
          await runReadCommand("app.state", options, { app: options.app });
        }),
      ),
  ),
);

const clickCommand = appOption(
  addTargetOptions(
    new Command()
      .name("click")
      .description(
        "Click an accessibility element or background screenshot coordinate",
      )
      .option("--snapshot-id <id>", "Snapshot id returned by get-app-state")
      .option("--element <id>", "Element id from get-app-state")
      .option("--element-index <index>", "Element index from get-app-state")
      .option("--x <points>", "Screenshot x coordinate fallback")
      .option("--y <points>", "Screenshot y coordinate fallback")
      .option("--button <button>", "Mouse button", "left")
      .option("--click-count <count>", "Number of clicks", "1")
      .action(
        withErrorHandler(async (options: ComputerUseClickOptions) => {
          const x = parseOptionalNonNegativeInteger(options.x, "x");
          const y = parseOptionalNonNegativeInteger(options.y, "y");
          const elementIndex = parseOptionalNonNegativeInteger(
            options.elementIndex,
            "element-index",
          );
          await runWriteCommand("element.click", options, {
            app: options.app,
            ...(options.snapshotId ? { snapshotId: options.snapshotId } : {}),
            ...(options.element ? { elementId: options.element } : {}),
            ...(elementIndex !== undefined ? { elementIndex } : {}),
            ...(x !== undefined ? { x } : {}),
            ...(y !== undefined ? { y } : {}),
            button: parseMouseButton(options.button),
            clickCount: parsePositiveInteger(options.clickCount, "click-count"),
          });
        }),
      ),
  ),
);

const scrollCommand = appOption(
  addTargetOptions(
    new Command()
      .name("scroll")
      .description("Scroll an accessibility element")
      .option("--snapshot-id <id>", "Snapshot id returned by get-app-state")
      .option("--element <id>", "Element id from get-app-state")
      .option("--element-index <index>", "Element index from get-app-state")
      .requiredOption(
        "--direction <direction>",
        "Scroll direction: up, down, left, or right",
      )
      .option("--pages <count>", "Number of pages to scroll", "1")
      .action(
        withErrorHandler(async (options: ComputerUseScrollOptions) => {
          await runWriteCommand("element.scroll", options, {
            app: options.app,
            ...(options.snapshotId ? { snapshotId: options.snapshotId } : {}),
            ...elementTargetPayload(options),
            direction: options.direction,
            pages: parsePositiveNumber(options.pages, "pages"),
          });
        }),
      ),
  ),
);

const setValueCommand = appOption(
  addTargetOptions(
    new Command()
      .name("set-value")
      .description("Set the value of a settable accessibility element")
      .option("--snapshot-id <id>", "Snapshot id returned by get-app-state")
      .option("--element <id>", "Element id from get-app-state")
      .option("--element-index <index>", "Element index from get-app-state")
      .requiredOption("--value <text>", "Value to assign")
      .action(
        withErrorHandler(async (options: ComputerUseSetValueOptions) => {
          await runWriteCommand("element.set_value", options, {
            app: options.app,
            ...(options.snapshotId ? { snapshotId: options.snapshotId } : {}),
            ...elementTargetPayload(options),
            value: options.value,
          });
        }),
      ),
  ),
);

const typeTextCommand = appOption(
  addTargetOptions(
    new Command()
      .name("type-text")
      .description("Type literal keyboard input into the target app")
      .option("--snapshot-id <id>", "Snapshot id returned by get-app-state")
      .requiredOption("--text <text>", "Text to type")
      .action(
        withErrorHandler(async (options: ComputerUseTypeTextOptions) => {
          await runWriteCommand("keyboard.type_text", options, {
            app: options.app,
            ...(options.snapshotId ? { snapshotId: options.snapshotId } : {}),
            text: options.text,
          });
        }),
      ),
  ),
);

const pressKeyCommand = appOption(
  addTargetOptions(
    new Command()
      .name("press-key")
      .description("Send a background key or key combination to the target app")
      .option("--snapshot-id <id>", "Snapshot id returned by get-app-state")
      .requiredOption(
        "--key <key>",
        "Key or xdotool-style combination, for example Command+K, shift+semicolon, or Control_L+J",
      )
      .action(
        withErrorHandler(async (options: ComputerUsePressKeyOptions) => {
          await runWriteCommand("keyboard.press_key", options, {
            app: options.app,
            ...(options.snapshotId ? { snapshotId: options.snapshotId } : {}),
            key: options.key,
          });
        }),
      ),
  ),
);

const performActionCommand = appOption(
  addTargetOptions(
    new Command()
      .name("perform-action")
      .description("Invoke a secondary accessibility action")
      .option("--snapshot-id <id>", "Snapshot id returned by get-app-state")
      .option("--element <id>", "Element id from get-app-state")
      .option("--element-index <index>", "Element index from get-app-state")
      .requiredOption("--action <name>", "Accessibility action name")
      .action(
        withErrorHandler(async (options: ComputerUsePerformActionOptions) => {
          await runWriteCommand("element.perform_action", options, {
            app: options.app,
            ...(options.snapshotId ? { snapshotId: options.snapshotId } : {}),
            ...elementTargetPayload(options),
            action: options.action,
          });
        }),
      ),
  ),
);

const openAppCommand = appOption(
  addTargetOptions(
    new Command()
      .name("open-app")
      .description("Open an app on the Desktop host without activating it")
      .action(
        withErrorHandler(async (options: ComputerUseAppOptions) => {
          await runWriteCommand("app.open", options, { app: options.app });
        }),
      ),
  ),
);

export const computerUseCommand = new Command()
  .name("computer-use")
  .description("Desktop app computer use through Okou CLI")
  .addHelpText("after", COMPUTER_USE_HELP_TEXT)
  .addCommand(listAppsCommand)
  .addCommand(getAppStateCommand)
  .addCommand(clickCommand)
  .addCommand(scrollCommand)
  .addCommand(setValueCommand)
  .addCommand(typeTextCommand)
  .addCommand(pressKeyCommand)
  .addCommand(performActionCommand)
  .addCommand(openAppCommand);
