type JsonObject = Readonly<Record<string, unknown>>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJsonString(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonString).join(",")}]`;
  }
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort(compareStrings)
      .map((key) => {
        return `${JSON.stringify(key)}:${canonicalJsonString(value[key])}`;
      })
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Canonical JSON received an unsupported value");
  }
  return encoded;
}
