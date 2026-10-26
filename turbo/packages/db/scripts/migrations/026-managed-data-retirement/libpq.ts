import { pg } from "./io";

// Values are encoded as UTF-8 hex, so they cannot alter SQL syntax. Arrays are
// decoded by PostgreSQL itself rather than a hand-written array serializer.
export function statement(
  parts: TemplateStringsArray,
  ...values: readonly (string | readonly string[])[]
): string {
  return parts.reduce((query, part, index) => {
    const value = values[index];
    if (value === undefined) return query + part;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const decoded = `convert_from(decode('${Buffer.from(text).toString("hex")}','hex'),'UTF8')`;
    const expression =
      typeof value === "string"
        ? decoded
        : `ARRAY(SELECT jsonb_array_elements_text(${decoded}::jsonb))`;
    return query + part + expression;
  }, "");
}

export async function jsonQuery(
  query: string,
  uri: string,
  bin: string | undefined,
  readOnly: boolean,
): Promise<unknown> {
  const result = await pg(
    "psql",
    [
      "--no-psqlrc",
      "--no-password",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--file",
      "-",
    ],
    uri,
    bin,
    `${query};\n`,
    readOnly,
  );
  return JSON.parse(result);
}

export async function queryRows(
  query: string,
  uri: string,
  bin: string | undefined,
  readOnly: boolean,
): Promise<unknown> {
  return jsonQuery(
    `SELECT COALESCE(jsonb_agg(result), '[]'::jsonb)::text FROM (${query}) AS result`,
    uri,
    bin,
    readOnly,
  );
}
