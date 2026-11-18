/**
 * Provider-neutral views of a saved Data Router body. Router passes provider
 * bodies through unchanged and publishes no result structure, so the CLI
 * derives field paths, types and array lengths from the JSON itself.
 */

const OUTLINE_MAX_LINES = 60;
const OUTLINE_MAX_DEPTH = 5;
const ARRAY_SAMPLE_SIZE = 50;
const STRING_PREVIEW_CHARS = 60;
const INLINE_OBJECT_MAX_KEYS = 8;
const INLINE_OBJECT_MAX_CHARS = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalarPreview(value: unknown): string {
  if (typeof value !== "string") return JSON.stringify(value) ?? "undefined";
  if (value.length <= STRING_PREVIEW_CHARS) return JSON.stringify(value);
  return `${JSON.stringify(`${value.slice(0, STRING_PREVIEW_CHARS)}…`)} (${value.length} chars)`;
}

function containerLabel(value: unknown): string | undefined {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (isRecord(value)) return `object(${Object.keys(value).length})`;
  return undefined;
}

/** First non-null value seen for each key across sampled array objects. */
function mergedFields(objects: readonly Record<string, unknown>[]) {
  const fields = new Map<string, unknown>();
  for (const object of objects) {
    for (const [key, value] of Object.entries(object)) {
      if (!fields.has(key) || (fields.get(key) === null && value !== null))
        fields.set(key, value);
    }
  }
  return fields;
}

/** A small object of scalar values on one line, such as `{unit: "C", degrees: 13.7}`. */
function inlineObject(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (
    entries.length === 0 ||
    entries.length > INLINE_OBJECT_MAX_KEYS ||
    entries.some(([, child]) => {
      return typeof child === "object" && child !== null;
    })
  )
    return undefined;
  const text = `{${entries
    .map(([key, child]) => {
      return `${key}: ${scalarPreview(child)}`;
    })
    .join(", ")}}`;
  return text.length <= INLINE_OBJECT_MAX_CHARS ? text : undefined;
}

function kindName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

class OutlineWriter {
  readonly lines: string[] = [];
  omitted = 0;

  add(line: string): void {
    if (this.lines.length < OUTLINE_MAX_LINES) this.lines.push(line);
    else this.omitted += 1;
  }

  entry(path: string, value: unknown, depth: number): void {
    const inline = inlineObject(value);
    if (inline) {
      this.add(`${path}: ${inline}`);
      return;
    }
    this.add(`${path}: ${containerLabel(value) ?? scalarPreview(value)}`);
    if (depth < OUTLINE_MAX_DEPTH) this.children(path, value, depth + 1);
  }

  children(path: string, value: unknown, depth: number): void {
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        this.entry(path ? `${path}.${key}` : key, child, depth);
      }
      return;
    }
    if (!Array.isArray(value) || value.length === 0) return;
    const sample = value.slice(0, ARRAY_SAMPLE_SIZE);
    const objects = sample.filter(isRecord);
    if (objects.length === sample.length) {
      for (const [key, child] of mergedFields(objects)) {
        this.entry(`${path}[].${key}`, child, depth);
      }
      return;
    }
    const kinds = [...new Set(sample.map(kindName))];
    this.add(
      `${path}[]: ${kinds.join(" | ")}, first ${scalarPreview(sample[0])}`,
    );
  }
}

/**
 * One line per field path with its type or a short value preview. Arrays show
 * their length and the fields found across their first elements.
 */
export function jsonOutline(value: unknown): string[] {
  const writer = new OutlineWriter();
  if (isRecord(value)) writer.children("", value, 1);
  else writer.entry("(root)", value, 1);
  if (writer.omitted > 0)
    writer.lines.push(
      `… ${writer.omitted} more fields; narrow with okou data show <ref> <path> --outline`,
    );
  return writer.lines;
}

type PathStep =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "each" };

/** Keys, `[n]` indexes and one `[]` element map, separated by optional dots. */
function parsePath(path: string): PathStep[] {
  const steps: PathStep[] = [];
  const pattern = /\.?(?:([^.[\]]+)|\[(\d*)\])/y;
  while (pattern.lastIndex < path.length) {
    const match = pattern.exec(path);
    if (!match) throw new Error(`Invalid JSON path: ${path}`);
    const [, key, index] = match;
    if (key !== undefined) steps.push({ kind: "key", key });
    else if (index) steps.push({ kind: "index", index: Number(index) });
    else steps.push({ kind: "each" });
  }
  if (
    steps.filter((step) => {
      return step.kind === "each";
    }).length > 1
  )
    throw new Error(`Only one [] element map is supported: ${path}`);
  return steps;
}

function applyStep(value: unknown, step: PathStep, path: string): unknown {
  if (step.kind === "each") {
    if (!Array.isArray(value))
      throw new Error(`${path} is ${kindName(value)}, not an array`);
    return value;
  }
  if (step.kind === "index") {
    if (!Array.isArray(value))
      throw new Error(`${path} is ${kindName(value)}, not an array`);
    if (step.index >= value.length)
      throw new Error(`${path} has ${value.length} items`);
    return value[step.index];
  }
  if (!isRecord(value))
    throw new Error(`${path || "(root)"} is ${kindName(value)}, not an object`);
  if (!Object.hasOwn(value, step.key)) {
    const keys = Object.keys(value).slice(0, 20).join(", ");
    throw new Error(
      `${path ? `${path}.` : ""}${step.key} does not exist; available keys: ${keys || "(none)"}`,
    );
  }
  return value[step.key];
}

/**
 * Select a dotted path such as `data.comments`, `data.comments[0].text` or
 * `data.comments[].text` (one value per array element).
 */
export function selectJsonPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  let mapped = false;
  let walked = "";
  for (const step of parsePath(path)) {
    if (mapped) {
      if (!Array.isArray(current)) throw new Error(`${walked} is not an array`);
      current = current.map((item) => {
        return applyStep(item, step, `${walked}[]`);
      });
    } else {
      current = applyStep(current, step, walked);
    }
    if (step.kind === "each") mapped = true;
    walked +=
      step.kind === "key"
        ? `${walked ? "." : ""}${step.key}`
        : step.kind === "index"
          ? `[${step.index}]`
          : "[]";
  }
  return current;
}
