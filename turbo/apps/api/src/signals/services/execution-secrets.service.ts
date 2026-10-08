import { command } from "ccstate";
import { encryptStoredSecretValue } from "./crypto.utils";

export type ExecutionSecrets = Readonly<Record<string, string>>;

/** Preserve the existing versioned envelope and null-versus-empty distinction. */
export const encryptExecutionSecrets$ = command(
  async (
    _context,
    secrets: ExecutionSecrets | null,
    signal: AbortSignal,
  ): Promise<string | null> => {
    signal.throwIfAborted();
    if (secrets === null) {
      return null;
    }
    const encrypted = await encryptStoredSecretValue(JSON.stringify(secrets));
    signal.throwIfAborted();
    return encrypted;
  },
);
