import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Command } from "commander";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  phoneUseContract,
  phoneActionSchema,
  type PhoneAction,
} from "@okouai/api-contracts/contracts/phone-use";
import { getClientConfig, handleError } from "../lib/api/core/client-factory";
import { withErrorHandler } from "../lib/command/with-error-handler";

async function client() {
  return initClient(phoneUseContract, await getClientConfig());
}
async function readOperation(operationId: string) {
  const api = await client();
  const response = await api.get({ params: { operationId } });
  if (response.status !== 200)
    handleError(response, "Could not read Phone Use operation");
  return response.body;
}
async function inspect(operationId: string, output?: string) {
  return renderOperation(await readOperation(operationId), output);
}
async function renderOperation(
  operation: Awaited<ReturnType<typeof readOperation>>,
  output?: string,
) {
  const operationId = operation.id;
  const api = await client();
  if (output && operation.status === "succeeded") {
    const screenshot = await api.screenshot({ params: { operationId } });
    if (screenshot.status === 200) {
      const url = new URL(screenshot.body.url);
      if (url.protocol !== "https:") throw new Error("Invalid screenshot URL");
      const image = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!image.ok)
        throw new Error(`Screenshot download failed: ${image.status}`);
      const bytes = new Uint8Array(await image.arrayBuffer());
      if (bytes.length > 6_000_000)
        throw new Error("Screenshot exceeds size limit");
      const dir = resolve(output);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${operationId}.png`);
      const temporary = join(dir, `.${operationId}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      console.log(
        JSON.stringify({ ...operation, screenshotPath: path }, null, 2),
      );
      return operation;
    } else if (screenshot.status !== 404)
      handleError(screenshot, "Could not download screenshot");
  }
  console.log(JSON.stringify(operation, null, 2));
  return operation;
}
async function execute(
  action: PhoneAction,
  options: { id?: string; wait?: string; output?: string },
) {
  const wait = Number(options.wait ?? "30");
  if (!Number.isFinite(wait) || wait < 0 || wait > 45)
    throw new Error("--wait must be between 0 and 45 seconds");
  const operationId = options.id ?? randomUUID();
  // Print the identity before the request so uncertain transport outcomes remain recoverable.
  console.error(`Phone Use operation: ${operationId}`);
  const response = await (
    await client()
  ).create({
    body: { id: operationId, action: phoneActionSchema.parse(action) },
  });
  if (response.status !== 200)
    handleError(
      response,
      `Operation submission is uncertain; inspect ${operationId} before retrying`,
    );
  const until = Date.now() + wait * 1000;
  let operation = response.body;
  while (
    ["queued", "running", "approval_required"].includes(operation.status) &&
    Date.now() < until
  ) {
    await delay(750);
    const current = await (await client()).get({ params: { operationId } });
    if (current.status !== 200)
      handleError(current, "Could not read operation; do not resubmit");
    operation = current.body;
  }
  await inspect(operationId, options.output);
}
export const phoneUseCommand = new Command("phone-use")
  .description("Internal iPhone automation through Okou iOS Use")
  .addHelpText(
    "after",
    `\nOpen Okou iOS Use, sign in, allow this chat and start a control window. Start a new Run after granting access.\nObserve before every input. Preserve operation IDs. Never replay unknown effects. Secrets and device unlock require the owner.\nFor send/publish/pay/order/delete and other sensitive commits, use --confirm with the exact consequence. Only the owner can confirm in Use. On approval_required, tell the owner to review in Use, then wait <operationId> without ending the Run or resubmitting. Ordinary navigation and scrolling run automatically.\n`,
  );
phoneUseCommand
  .command("devices")
  .description("List your registered phones")
  .action(
    withErrorHandler(async () => {
      const result = await (await client()).devices();
      if (result.status !== 200) handleError(result, "Could not list phones");
      console.log(JSON.stringify(result.body, null, 2));
    }),
  );
phoneUseCommand
  .command("status <operationId>")
  .option("--output <dir>", "Save a private screenshot")
  .action(
    withErrorHandler(async (id: string, options: { output?: string }) => {
      await inspect(id, options.output);
    }),
  );
phoneUseCommand
  .command("wait <operationId>")
  .description(
    "Wait for an existing operation or owner review; never resubmit input",
  )
  .option("--timeout <seconds>", "Wait at most 300 seconds", "300")
  .option("--output <dir>", "Save a private screenshot")
  .action(
    withErrorHandler(
      async (id: string, options: { timeout: string; output?: string }) => {
        const seconds = Number(options.timeout);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 300)
          throw new Error("--timeout must be between 0 and 300 seconds");
        const until = Date.now() + seconds * 1000;
        while (true) {
          const operation = await readOperation(id);
          if (
            !["queued", "running", "approval_required"].includes(
              operation.status,
            ) ||
            Date.now() >= until
          ) {
            await renderOperation(operation, options.output);
            return;
          }
          await delay(Math.min(2000, Math.max(0, until - Date.now())));
        }
      },
    ),
  );
function actionCommand(name: string, description: string) {
  return phoneUseCommand
    .command(name)
    .description(description)
    .option(
      "--id <uuid>",
      "Stable operation identity; reuse only for the identical request",
    )
    .option("--wait <seconds>", "Wait up to 45 seconds", "30")
    .option("--output <dir>", "Save a private screenshot");
}
actionCommand("start", "Begin an exclusive native task session")
  .requiredOption("--goal <goal>", "Concrete task goal")
  .action(
    withErrorHandler(
      async (options: {
        goal: string;
        id?: string;
        wait?: string;
        output?: string;
      }) => {
        return execute({ kind: "session.start", goal: options.goal }, options);
      },
    ),
  );
actionCommand("observe", "Observe the foreground app").action(
  withErrorHandler(
    async (options: { id?: string; wait?: string; output?: string }) => {
      return execute({ kind: "observe" }, options);
    },
  ),
);
actionCommand("open <bundleId>", "Open an app").action(
  withErrorHandler(
    async (
      app: string,
      options: { id?: string; wait?: string; output?: string },
    ) => {
      return execute({ kind: "app.open", app }, options);
    },
  ),
);
actionCommand("tap", "Tap an element from a current snapshot")
  .requiredOption("--app <bundleId>", "Expected app")
  .requiredOption("--snapshot <uuid>", "Snapshot ID")
  .requiredOption("--element <id>", "Element ID")
  .option(
    "--confirm <consequence>",
    "Require one local owner confirmation for this commit",
  )
  .action(
    withErrorHandler(
      async (options: {
        app: string;
        snapshot: string;
        element: string;
        confirm?: string;
        id?: string;
        wait?: string;
        output?: string;
      }) => {
        return execute(
          {
            kind: "tap",
            app: options.app,
            snapshotId: options.snapshot,
            elementId: options.element,
            ...(options.confirm ? { confirmation: options.confirm } : {}),
          },
          options,
        );
      },
    ),
  );
actionCommand("type", "Type into the current ordinary text field")
  .requiredOption("--app <bundleId>", "Expected app")
  .requiredOption("--snapshot <uuid>", "Snapshot ID")
  .requiredOption("--text <text>", "Text without control characters")
  .action(
    withErrorHandler(
      async (options: {
        app: string;
        snapshot: string;
        text: string;
        id?: string;
        wait?: string;
        output?: string;
      }) => {
        return execute(
          {
            kind: "type",
            app: options.app,
            snapshotId: options.snapshot,
            text: options.text,
          },
          options,
        );
      },
    ),
  );
actionCommand("swipe", "Scroll the current app")
  .requiredOption("--app <bundleId>", "Expected app")
  .requiredOption("--snapshot <uuid>", "Snapshot ID")
  .requiredOption("--direction <direction>", "up, down, left or right")
  .option(
    "--confirm <consequence>",
    "Require one local owner confirmation for this commit",
  )
  .action(
    withErrorHandler(
      async (options: {
        app: string;
        snapshot: string;
        direction: PhoneAction["direction"];
        confirm?: string;
        id?: string;
        wait?: string;
        output?: string;
      }) => {
        return execute(
          {
            kind: "swipe",
            app: options.app,
            snapshotId: options.snapshot,
            direction: options.direction,
            ...(options.confirm ? { confirmation: options.confirm } : {}),
          },
          options,
        );
      },
    ),
  );
actionCommand(
  "stop",
  "Close this Run's phone admission; in-flight authorized input may finish",
).action(
  withErrorHandler(
    async (options: { id?: string; wait?: string; output?: string }) => {
      return execute({ kind: "session.stop" }, options);
    },
  ),
);
