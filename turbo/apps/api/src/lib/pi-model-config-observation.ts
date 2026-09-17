export interface PiModelConfigObservation {
  readonly piModelConfigGeneration: 1 | 2 | 3 | 4 | "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only bounded metadata may cross this boundary, never captured config values. */
export function piModelConfigObservation(
  cliAgentType: string | undefined,
  config: unknown,
): PiModelConfigObservation | undefined {
  if (cliAgentType !== "pi") {
    return undefined;
  }
  if (!isRecord(config)) {
    return {
      piModelConfigGeneration: "unknown",
    };
  }
  const generation = !("schemaVersion" in config)
    ? 1
    : config.schemaVersion === 2 ||
        config.schemaVersion === 3 ||
        config.schemaVersion === 4
      ? config.schemaVersion
      : "unknown";
  return {
    piModelConfigGeneration: generation,
  };
}
