import chalk from "chalk";
import {
  PLAN_UPGRADE_CLI_HINT,
  PLAN_UPGRADE_RUN_GUIDANCE,
  RUN_ERROR_GUIDANCE,
} from "@okouai/api-contracts/contracts/errors";
import { ApiRequestError } from "../api/core/client-factory";
import { getOkouToken } from "../okou-env";

/**
 * Wraps a Commander.js action handler with centralized error handling.
 *
 * Catches errors thrown by the action, formats them consistently,
 * and calls process.exit(1). Commands with specific error handling
 * should use an inner try/catch and re-throw for generic handling.
 */
export function withErrorHandler<T extends unknown[]>(
  fn: (...args: T) => Promise<void>,
  renderError?: (error: unknown, ...args: T) => boolean,
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (error) {
      if (renderError?.(error, ...args)) {
        process.exit(1);
      }
      if (error instanceof ApiRequestError) {
        if (error.code === "UNAUTHORIZED") {
          if (getOkouToken()) {
            console.error(chalk.red("✗ Authentication failed"));
            console.error(chalk.dim("  OKOU_TOKEN is invalid or expired"));
          } else {
            console.error(chalk.red("✗ Not authenticated"));
            console.error(chalk.dim("  Set OKOU_TOKEN to a valid run token"));
          }
        } else {
          const guidance = RUN_ERROR_GUIDANCE[error.code];
          if (guidance) {
            const planUpgradeRequired = error.code === "PRO_REQUIRED";
            const guidanceText = planUpgradeRequired
              ? `${guidance.guidance} ${PLAN_UPGRADE_RUN_GUIDANCE}`
              : guidance.guidance;
            const cliHint = planUpgradeRequired
              ? PLAN_UPGRADE_CLI_HINT
              : guidance.cliHint;
            console.error(chalk.red(`✗ ${guidance.title}`));
            console.error(chalk.dim(`  ${guidanceText}`));
            if (cliHint) {
              console.error(chalk.dim(`  Run: ${cliHint}`));
            }
          } else {
            console.error(chalk.red(`✗ ${error.status}: ${error.message}`));
          }
        }
      } else if (error instanceof Error) {
        console.error(chalk.red(`✗ ${error.message}`));
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }

      if (error instanceof Error && error.cause instanceof Error) {
        console.error(chalk.dim(`  Cause: ${error.cause.message}`));
      }

      process.exit(1);
    }
  };
}
