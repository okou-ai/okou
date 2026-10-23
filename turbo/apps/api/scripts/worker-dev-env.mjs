/** Serialize packed API configuration using dotenv's literal single quotes. */
export function serializeWorkerDevVars(environment) {
  // dotenv does not JSON-unescape double-quoted values. JSON's unicode escape
  // keeps apostrophes inside the literal value without changing decoded secrets.
  const packed = JSON.stringify(environment).replaceAll(
    "'",
    String.raw`\u0027`,
  );
  return `API_ENV_JSON_PARTS=1\nAPI_ENV_JSON_0='${packed}'\n`;
}
