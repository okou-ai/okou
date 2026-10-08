import packageJson from "../package.json";

/**
 * Release version of this runtime build.
 *
 * The API records it in every Pi launch config and the sandbox compares it
 * before starting a session so the captured launch and installed runtime
 * describe one supported execution contract.
 */
export const PI_AGENT_RUNTIME_VERSION: string = packageJson.version;
