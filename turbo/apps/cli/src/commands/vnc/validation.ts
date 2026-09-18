import { z } from "zod";
import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";

export class VncCommandError extends Error {
  constructor(
    readonly reason: "permission_denied" | "invalid_input",
    message: string,
  ) {
    super(message);
  }
}

export function requireVncCapability(capability: "vnc:read" | "vnc:write") {
  if (!decodeSandboxTokenPayload()?.capabilities.includes(capability))
    throw new VncCommandError(
      "permission_denied",
      `This command requires a Run token with ${capability}. Ask the owner to enable VNC access, then start a new Run.`,
    );
}

function invalid(message: string): never {
  throw new VncCommandError("invalid_input", message);
}

export function vncId(value: string): string {
  if (!z.uuid().safeParse(value).success)
    invalid("Use an exact UUID from vnc host list or vnc session list.");
  return value.toLowerCase();
}

export function vncMode(value: string | undefined): "shared" | "exclusive" {
  if (value !== "shared" && value !== "exclusive")
    invalid("Choose --mode shared or --mode exclusive explicitly.");
  return value;
}

function json(value: string | undefined, limit: number): unknown {
  if (value === undefined || Buffer.byteLength(value) > limit)
    invalid("Supply bounded JSON for geometry or drag points; read --help.");
  try {
    return JSON.parse(value);
  } catch {
    invalid("Geometry and drag points must be valid JSON; read --help.");
  }
}

const geometrySchema = z.strictObject({
  sessionId: z.uuid().transform((value) => {
    return value.toLowerCase();
  }),
  epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export function vncGeometry(value: string | undefined) {
  const result = geometrySchema.safeParse(json(value, 4096));
  if (!result.success)
    invalid(
      "Use the exact {sessionId,epoch} geometry from a fresh screenshot; epoch must be a nonnegative safe integer.",
    );
  return result.data;
}

function integer(value: string | undefined, min: number, max: number): number {
  if (value === undefined || !/^-?\d{1,16}$/.test(value))
    invalid(
      "Coordinates and step counts must be decimal integers; read --help.",
    );
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    invalid("Coordinates or step counts are outside the supported range.");
  return parsed;
}

export function vncCoordinate(value: string | undefined): number {
  return integer(value, 0, 65535);
}

const pointsSchema = z
  .array(
    z.tuple([
      z.number().int().min(0).max(65535),
      z.number().int().min(0).max(65535),
    ]),
  )
  .min(2)
  .max(256);

export function vncPoints(value: string | undefined) {
  const result = pointsSchema.safeParse(json(value, 16384));
  if (!result.success)
    invalid(
      "Drag requires 2–256 [x,y] pairs with integer coordinates 0–65535.",
    );
  return result.data;
}

export function vncButton(
  value: string | undefined,
): "left" | "middle" | "right" {
  if (value !== "left" && value !== "middle" && value !== "right")
    invalid("Choose --button left, middle or right.");
  return value;
}

export function vncAxis(value: string | undefined): "vertical" | "horizontal" {
  if (value !== "vertical" && value !== "horizontal")
    invalid("Choose --axis vertical or --axis horizontal.");
  return value;
}

export function vncSteps(value: string | undefined): number {
  const steps = integer(value, -100, 100);
  if (steps === 0) invalid("Scroll requires 1–100 steps in either direction.");
  return steps;
}

function printable(character: string): boolean {
  const scalar = character.codePointAt(0);
  return (
    scalar !== undefined &&
    !(scalar >= 0xd800 && scalar <= 0xdfff) &&
    !/\p{Cc}/u.test(character)
  );
}

export function vncText(value: string | undefined): string {
  if (value === undefined || !value.length || Buffer.byteLength(value) > 4096)
    invalid(
      "Text must contain 1–4096 UTF-8 bytes and at most 2048 characters.",
    );
  let characters = 0;
  for (const character of value) {
    characters++;
    if (
      characters > 2048 ||
      (character !== "\n" && character !== "\t" && !printable(character))
    )
      invalid(
        "Text allows at most 4096 press/release events; only newline and tab control characters are supported.",
      );
  }
  return value;
}

const namedKeys = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Left",
  "Right",
  "Up",
  "Down",
  "Shift",
  "Control",
  "Alt",
  "Meta",
]);

export function vncKeys(value: string[] | undefined): string[] {
  if (
    value === undefined ||
    value.length < 1 ||
    value.length > 8 ||
    new Set(value).size !== value.length ||
    value.some((key) => {
      return (
        !namedKeys.has(key) &&
        !/^F(?:[1-9]|[12]\d|3[0-5])$/.test(key) &&
        !([...key].length === 1 && printable(key))
      );
    })
  )
    invalid(
      "Use 1–8 distinct printable characters or supported key names; read key --help.",
    );
  return value;
}

export function vncOutputPath(value: string | undefined): string {
  if (
    value === undefined ||
    !value.length ||
    Buffer.byteLength(value) > 4096 ||
    value.includes("\0")
  )
    invalid("Supply --output with a local file path of 1–4096 UTF-8 bytes.");
  return value;
}
