const SERIALIZED_VALUE_MAX_DEPTH = 32;
const SERIALIZED_OBJECT_MAX_ENTRIES = 64;
const SERIALIZED_VALUE_MAX_NODES = 1024;
const SERIALIZED_STRING_MAX_LENGTH = 4096;
const CIRCULAR_MARKER = "[Circular]";
const TRUNCATED_MARKER = "[Truncated]";
const UNREADABLE_MARKER = "[Unreadable]";

interface SerializationState {
  readonly seen: WeakSet<object>;
  nodes: number;
}

interface BoundedEntries {
  readonly entries: readonly [string, unknown][];
  readonly truncated: boolean;
}

function hasOwnSerializedField(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function setSerializedField(
  value: Record<string, unknown>,
  key: string,
  child: unknown,
): void {
  Object.defineProperty(value, key, {
    value: child,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Extract message string from log arguments.
 */
export function formatMessage(args: unknown[]): string {
  if (args.length === 0) return "";
  if (typeof args[0] === "string") return args[0];
  if (args[0] instanceof Error) {
    const message = safeReadValue(() => {
      return args[0] instanceof Error ? args[0].message : undefined;
    });
    return typeof message === "string" ? message : UNREADABLE_MARKER;
  }
  return safeString(args[0]);
}

/**
 * Serialize an Error instance into a plain object. Error's built-in
 * properties (name, message, stack, cause) are non-enumerable, so spreading
 * an Error loses them. This explicitly copies them plus any additional
 * enumerable own properties (e.g. code, statusCode on custom errors).
 */
function serializeErrorWithSeen(
  err: Error,
  state: SerializationState,
  depth: number,
): Record<string, unknown> {
  const name = safeReadValue(() => {
    return err.name;
  });
  const message = safeReadValue(() => {
    return err.message;
  });
  const serialized: Record<string, unknown> = {
    name: typeof name === "string" ? name : "Error",
    message:
      typeof message === "string"
        ? serializeStringValue(message)
        : UNREADABLE_MARKER,
  };
  state.seen.add(err);
  const stack = safeReadValue(() => {
    return err.stack;
  });
  if (stack !== undefined) {
    setSerializedField(
      serialized,
      "stack",
      typeof stack === "string"
        ? serializeStringValue(stack)
        : serializeErrorValue(stack, state, depth + 1),
    );
  }
  const cause = safeReadValue(() => {
    return err.cause;
  });
  if (cause !== undefined) {
    setSerializedField(
      serialized,
      "cause",
      serializeErrorValue(cause, state, depth + 1),
    );
  }
  const result = safeOwnEnumerableEntries(err);
  if (!result) {
    serialized.__unreadable = true;
    return serialized;
  }
  for (const [key, value] of result.entries) {
    if (!hasOwnSerializedField(serialized, key)) {
      setSerializedField(
        serialized,
        key,
        serializeErrorValue(value, state, depth + 1),
      );
    }
  }
  if (result.truncated) {
    setSerializedField(serialized, "__truncated", true);
  }
  return serialized;
}

export function serializeError(err: unknown): Record<string, unknown> {
  const state: SerializationState = { seen: new WeakSet<object>(), nodes: 0 };
  if (err instanceof Error) {
    reserveSerializedNode(state);
    return serializeErrorWithSeen(err, state, 0);
  }
  return { value: serializeErrorValue(err, state, 0) };
}

function safeReadValue(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return UNREADABLE_MARKER;
  }
}

function safeOwnEnumerableEntries(value: object): BoundedEntries | null {
  const entries: [string, unknown][] = [];
  try {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        continue;
      }
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
        continue;
      }
      if (entries.length >= SERIALIZED_OBJECT_MAX_ENTRIES) {
        return { entries, truncated: true };
      }
      const child = safeReadValue(() => {
        return (value as Record<string, unknown>)[key];
      });
      entries.push([key, child]);
    }
  } catch {
    return null;
  }
  return { entries, truncated: false };
}

function safeString(value: unknown): string {
  const result = safeReadValue(() => {
    return String(value);
  });
  return typeof result === "string" ? result : UNREADABLE_MARKER;
}

function serializeStringValue(value: string): string {
  if (value.length <= SERIALIZED_STRING_MAX_LENGTH) {
    return value;
  }
  return `${value.slice(0, SERIALIZED_STRING_MAX_LENGTH - 3)}...`;
}

function serializeFunctionValue(value: { readonly name: string }): string {
  const name = safeReadValue(() => {
    return value.name;
  });
  return typeof name === "string" && name
    ? serializeStringValue(`[Function ${name}]`)
    : "[Function]";
}

function serializeNonObjectValue(value: unknown): unknown {
  if (typeof value === "string") {
    return serializeStringValue(value);
  }
  if (typeof value === "bigint" || typeof value === "symbol") {
    return serializeStringValue(safeString(value));
  }
  if (typeof value === "function") {
    return serializeFunctionValue(value);
  }
  return value;
}

function isObjectValue(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function serializeDateValue(value: Date): unknown {
  const time = safeReadValue(() => {
    return value.getTime();
  });
  if (typeof time !== "number" || Number.isNaN(time)) {
    return serializeStringValue(safeString(value));
  }
  const iso = safeReadValue(() => {
    return value.toISOString();
  });
  return typeof iso === "string" ? iso : UNREADABLE_MARKER;
}

function serializeArrayValue(
  value: readonly unknown[],
  state: SerializationState,
  depth: number,
): unknown {
  const result = safeOwnEnumerableEntries(value);
  if (!result) {
    return UNREADABLE_MARKER;
  }
  const items = result.entries.map((item) => {
    const [, child] = item;
    return serializeErrorValue(child, state, depth + 1);
  });
  if (result.truncated) {
    items.push(TRUNCATED_MARKER);
  }
  return items;
}

function serializePlainObjectValue(
  value: object,
  state: SerializationState,
  depth: number,
): unknown {
  const result = safeOwnEnumerableEntries(value);
  if (!result) {
    return UNREADABLE_MARKER;
  }
  const serialized: Record<string, unknown> = {};
  for (const [key, child] of result.entries) {
    setSerializedField(
      serialized,
      key,
      serializeErrorValue(child, state, depth + 1),
    );
  }
  if (result.truncated) {
    setSerializedField(serialized, "__truncated", true);
  }
  return serialized;
}

function reserveSerializedNode(state: SerializationState): boolean {
  if (state.nodes >= SERIALIZED_VALUE_MAX_NODES) {
    return false;
  }
  state.nodes += 1;
  return true;
}

function serializeErrorValue(
  value: unknown,
  state: SerializationState,
  depth: number,
): unknown {
  if (!reserveSerializedNode(state)) {
    return TRUNCATED_MARKER;
  }
  if (!isObjectValue(value)) {
    return serializeNonObjectValue(value);
  }
  if (state.seen.has(value)) {
    return CIRCULAR_MARKER;
  }
  if (depth > SERIALIZED_VALUE_MAX_DEPTH) {
    return TRUNCATED_MARKER;
  }
  if (value instanceof Error) {
    return serializeErrorWithSeen(value, state, depth);
  }
  if (value instanceof Date) {
    return serializeDateValue(value);
  }
  if (value instanceof RegExp) {
    return serializeStringValue(safeString(value));
  }

  state.seen.add(value);
  if (Array.isArray(value)) {
    return serializeArrayValue(value, state, depth);
  }
  return serializePlainObjectValue(value, state, depth);
}

/**
 * Extract structured fields from log arguments.
 * If second argument is an object, use it as fields.
 * If second argument is an Error, wrap it under `error` with non-enumerable
 * properties (name/message/stack/cause) explicitly serialized.
 * Otherwise, wrap remaining arguments in an 'args' field.
 */
export function extractFields(args: unknown[]): Record<string, unknown> {
  if (args.length <= 1) {
    if (args.length === 1 && args[0] instanceof Error) {
      return { error: serializeError(args[0]) };
    }
    return {};
  }
  const fields = args.slice(1);
  if (
    fields.length === 1 &&
    typeof fields[0] === "object" &&
    fields[0] !== null
  ) {
    const value = fields[0];
    if (value instanceof Error) {
      return { error: serializeError(value) };
    }
    return value as Record<string, unknown>;
  }
  return { args: fields };
}
