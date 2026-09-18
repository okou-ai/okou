import { Command } from "commander";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { createVncHostCommand } from "./host";
import { outputVncCommandError, outputVncOutcome } from "./output";
import type { VncMethod } from "./protocol";
import { invokeVncRpc } from "./rpc";
import {
  requireVncCapability,
  vncAxis,
  vncButton,
  vncCoordinate,
  vncGeometry,
  vncId,
  vncKeys,
  vncMode,
  vncOutputPath,
  vncPoints,
  vncSteps,
  vncText,
} from "./validation";

interface Options {
  readonly json?: boolean;
}

async function execute(
  method: VncMethod,
  options: Options,
  params: () => Record<string, unknown>,
  capture?: () => { path: string; overwrite: boolean },
): Promise<void> {
  try {
    requireVncCapability("vnc:write");
    outputVncOutcome(
      await invokeVncRpc(method, params(), capture?.()),
      options.json,
    );
  } catch (error) {
    outputVncCommandError(error, options.json, method === "vnc.input");
  }
}

const INPUT_HELP = `
Input is sent once, without replay. outcome=unknown or delivery=unknown means none, some or all may have taken effect. Inspect a fresh screenshot before deciding what to do next. outcome=sent means written and flushed, not acknowledged by the application.`;

const GEOMETRY_HELP = `
Use --geometry '{"sessionId":"<geometry-id>","epoch":0}' from a fresh screenshot, not the RPC session ID. Coordinates are integer framebuffer pixels (0–65535); Runner also checks current dimensions. Geometry can become stale after a resize. Re-capture and re-evaluate; never retry input automatically.`;

function inputCommand(name: string, description: string) {
  return new Command(name)
    .description(description)
    .argument("<session-id>", "Exact ID from vnc session start or list")
    .option("--json", "Print structured outcome")
    .addHelpText("after", INPUT_HELP);
}

function coordinateCommand(name: string, description: string) {
  return inputCommand(name, description)
    .option(
      "--geometry <json>",
      "Required exact {sessionId,epoch} from screenshot",
    )
    .addHelpText("after", GEOMETRY_HELP);
}

interface CoordinateOptions extends Options {
  readonly geometry?: string;
  readonly x?: string;
  readonly y?: string;
}

function createSessionCommand() {
  const session = new Command("session")
    .description("Manage this Run's active VNC sessions (up to two)")
    .addHelpText(
      "after",
      "\nSessions belong to this Run and expire within two hours. Status checks authority and returns metadata; it does not probe the desktop. After an uncertain start, inspect list instead of starting again automatically. Close sessions when finished.",
    );
  session.addCommand(
    new Command("start")
      .description(
        "Connect to an authorized saved host with an explicit native sharing mode",
      )
      .argument("<connection-id>", "Exact ID from vnc host list")
      .option(
        "--mode <shared|exclusive>",
        "Required requested ClientInit sharing mode",
      )
      .option("--json", "Print session ID and requested mode")
      .addHelpText(
        "after",
        "\nShared viewers can interfere with one another. Exclusive mode can disconnect other viewers; the VNC server may refuse or override it. Success is not proof of exclusive control. Never retry with another mode automatically.",
      )
      .action(
        withErrorHandler(
          async (
            connectionId: string,
            options: Options & { mode?: string },
          ) => {
            await execute("vnc.session.start", options, () => {
              return {
                connectionId: vncId(connectionId),
                mode: vncMode(options.mode),
              };
            });
          },
        ),
      ),
  );
  session.addCommand(
    new Command("list")
      .description("List active sessions owned by this Run")
      .option("--json", "Print sessions and their requested modes")
      .action(
        withErrorHandler(async (options: Options) => {
          await execute("vnc.session.list", options, () => {
            return {};
          });
        }),
      ),
  );
  for (const method of ["status", "close"] as const)
    session.addCommand(
      new Command(method)
        .description(
          method === "status"
            ? "Check current authority and inspect session metadata"
            : "Close this Run's session and release its resources",
        )
        .argument("<session-id>", "Exact ID from vnc session start or list")
        .option("--json", "Print structured outcome")
        .action(
          withErrorHandler(async (sessionId: string, options: Options) => {
            await execute(`vnc.session.${method}`, options, () => {
              return { sessionId: vncId(sessionId) };
            });
          }),
        ),
    );
  return session;
}

export function createVncCommand() {
  const vnc = new Command("vnc")
    .description("Control owner-configured VNC desktops from an authorized Run")
    .addHelpText(
      "after",
      `
Start with okou vnc host list --json, then read the relevant subcommand's --help. Credentials and trust configuration stay with the saved host; commands accept no endpoint, password or insecure override.

Choose session start --mode shared or --mode exclusive explicitly. Shared viewers can interfere; exclusive requests may disconnect other viewers or be refused/overridden by the server. Neither mode provides an Okou-wide control lock.

Take a screenshot with --output <file> --json before coordinate input. Reuse its exact geometry, then take another screenshot to inspect the result. Never automatically replay an uncertain operation or switch sharing modes on failure. Close sessions when finished.

VNC requires the owner's grant, an enabled VNC feature and a supporting Runner. A listed host is not a connectivity check. Ask the owner to check saved host diagnostics if connection or authentication fails.`,
    )
    .addCommand(createVncHostCommand())
    .addCommand(createSessionCommand());

  vnc.addCommand(
    new Command("screenshot")
      .description(
        "Publish one complete fresh PNG atomically and return its geometry",
      )
      .argument("<session-id>", "Exact ID from vnc session start or list")
      .option("--output <path>", "Required local PNG destination")
      .option("--overwrite", "Atomically replace an existing regular file")
      .option("--json", "Print image metadata, geometry, path and SHA-256")
      .addHelpText(
        "after",
        "\nPNG is at most 16 MiB and excludes the cursor. Existing targets are refused unless --overwrite is explicit. Partial data remains private and is never published. A complete frame does not establish that the application has settled.",
      )
      .action(
        withErrorHandler(
          async (
            sessionId: string,
            options: Options & { output?: string; overwrite?: boolean },
          ) => {
            await execute(
              "vnc.capture",
              options,
              () => {
                return { sessionId: vncId(sessionId) };
              },
              () => {
                return {
                  path: vncOutputPath(options.output),
                  overwrite: options.overwrite === true,
                };
              },
            );
          },
        ),
      ),
  );
  vnc.addCommand(
    coordinateCommand(
      "click",
      "Click and release one button at a framebuffer coordinate",
    )
      .option("--x <n>", "Required horizontal coordinate")
      .option("--y <n>", "Required vertical coordinate")
      .option("--button <left|middle|right>", "Pointer button", "left")
      .action(
        withErrorHandler(
          async (
            sessionId: string,
            options: CoordinateOptions & { button?: string },
          ) => {
            await execute("vnc.input", options, () => {
              return {
                sessionId: vncId(sessionId),
                input: {
                  type: "click",
                  geometry: vncGeometry(options.geometry),
                  x: vncCoordinate(options.x),
                  y: vncCoordinate(options.y),
                  button: vncButton(options.button),
                },
              };
            });
          },
        ),
      ),
  );
  vnc.addCommand(
    coordinateCommand(
      "drag",
      "Press at the first point, visit each point and release at the last",
    )
      .option(
        "--points <json>",
        "Required 2–256 [x,y] pairs, for example [[10,20],[30,40]]",
      )
      .option("--button <left|middle|right>", "Pointer button", "left")
      .action(
        withErrorHandler(
          async (
            sessionId: string,
            options: Options & {
              geometry?: string;
              points?: string;
              button?: string;
            },
          ) => {
            await execute("vnc.input", options, () => {
              return {
                sessionId: vncId(sessionId),
                input: {
                  type: "drag",
                  geometry: vncGeometry(options.geometry),
                  points: vncPoints(options.points),
                  button: vncButton(options.button),
                },
              };
            });
          },
        ),
      ),
  );
  vnc.addCommand(
    coordinateCommand(
      "scroll",
      "Send 1–100 wheel steps at a framebuffer coordinate",
    )
      .option("--x <n>", "Required horizontal coordinate")
      .option("--y <n>", "Required vertical coordinate")
      .option("--axis <vertical|horizontal>", "Required scroll axis")
      .option(
        "--steps <signed-count>",
        "Required nonzero count, -100 to 100; positive is down/right",
      )
      .action(
        withErrorHandler(
          async (
            sessionId: string,
            options: CoordinateOptions & { axis?: string; steps?: string },
          ) => {
            await execute("vnc.input", options, () => {
              return {
                sessionId: vncId(sessionId),
                input: {
                  type: "scroll",
                  geometry: vncGeometry(options.geometry),
                  x: vncCoordinate(options.x),
                  y: vncCoordinate(options.y),
                  axis: vncAxis(options.axis),
                  steps: vncSteps(options.steps),
                },
              };
            });
          },
        ),
      ),
  );
  vnc.addCommand(
    inputCommand("text", "Type Unicode keysyms (not clipboard transfer)")
      .option(
        "--text <text>",
        "Required text, up to 4096 UTF-8 bytes and 2048 characters",
      )
      .addHelpText(
        "after",
        "\nOnly newline and tab control characters are allowed. Each character emits a press and release; insertion depends on the VNC server, keyboard layout and application.",
      )
      .action(
        withErrorHandler(
          async (sessionId: string, options: Options & { text?: string }) => {
            await execute("vnc.input", options, () => {
              return {
                sessionId: vncId(sessionId),
                input: { type: "text", text: vncText(options.text) },
              };
            });
          },
        ),
      ),
  );
  vnc.addCommand(
    inputCommand(
      "key",
      "Press 1–8 distinct keys in order, then release in reverse",
    )
      .option(
        "--keys <keys...>",
        "Required printable characters or named keys, for example Control a",
      )
      .addHelpText(
        "after",
        "\nKey names are case-sensitive: Enter, Tab, Escape, Backspace, Delete, Insert, Home, End, PageUp, PageDown, Left, Right, Up, Down, Shift, Control, Alt, Meta, F1–F35. A single printable Unicode character is also accepted.",
      )
      .action(
        withErrorHandler(
          async (sessionId: string, options: Options & { keys?: string[] }) => {
            await execute("vnc.input", options, () => {
              return {
                sessionId: vncId(sessionId),
                input: { type: "key_chord", keys: vncKeys(options.keys) },
              };
            });
          },
        ),
      ),
  );
  return vnc;
}

export const vncCommand = createVncCommand();
