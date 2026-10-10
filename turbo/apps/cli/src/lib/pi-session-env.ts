export const PI_SESSION_ROLE_ENV = "OKOU_PI_SESSION_ROLE";
export const PI_EFFECTIVE_THINKING_ENV = "OKOU_PI_EFFECTIVE_THINKING_LEVEL";

/** A convenience gate, not a sandbox security boundary. */
export function isPiParentSession(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[PI_SESSION_ROLE_ENV] === "parent" && Boolean(env.OKOU_RUN_ID);
}

export function requirePiParentSession(): void {
  if (!isPiParentSession()) {
    throw new Error("Subagents are available only in a parent Pi session.");
  }
}

export function requirePiMainLoopEnvironment(): void {
  if (
    process.env[PI_SESSION_ROLE_ENV] === "child" ||
    !process.env.OKOU_RUN_ID ||
    !process.env.OKOU_PI_SESSION_ID ||
    !process.env.OKOU_PI_MODEL_CONFIG ||
    !process.env.OKOU_PI_LAUNCH_PAYLOAD_FILE
  ) {
    throw new Error("The main loop requires a guest-launched Pi session.");
  }
}
