import packageJson from "../package.json";

/**
 * Release version of this runtime build.
 *
 * The API records it in every Pi launch config and the sandbox compares it
 * exactly before continuing an API-first pending-tool handoff, because prompt
 * and tool-schema parity between the two owners is a byte-equality contract
 * that only holds for one immutable runtime build.
 */
export const PI_AGENT_RUNTIME_VERSION: string = packageJson.version;
