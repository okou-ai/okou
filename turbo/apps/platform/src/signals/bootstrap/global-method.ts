import { command } from "ccstate";
import { getBuildCommitSha } from "../../lib/build-info";
import type { DebugLoggers } from "../../types/global-method.ts";
import { getLoggers, Level, logger } from "../log";
import { inspectLogInput$ } from "./inspect-log-input";
import { extendDebugLoggerLocalStorage$ } from "./loggers";

const L = logger("GlobalMethod");
const ENABLE_DEBUG_LOGGER_EVENT = "okou:enable-debug-logger";

function createLoggerControl(
  name: string,
  onDebugEnabled: (loggerName: string) => void,
): DebugLoggers[string] {
  const loggerInstance = getLoggers()[name];
  if (!loggerInstance) {
    throw new Error(`Logger "${name}" not found`);
  }

  return {
    get debug() {
      return loggerInstance.shouldLog(Level.Debug);
    },
    set debug(value: boolean) {
      if (value) {
        loggerInstance.level = Level.Debug;
        onDebugEnabled(name);
      } else if (loggerInstance.level === Level.Debug) {
        loggerInstance.level = Level.Info;
      }
    },
  };
}

function createDebugLoggers(
  onDebugEnabled: (loggerName: string) => void,
): DebugLoggers {
  const result: DebugLoggers = {};
  for (const name of Object.keys(getLoggers())) {
    result[name] = createLoggerControl(name, onDebugEnabled);
  }
  return result;
}

export const setupGlobalMethod$ = command(
  ({ get, set }, signal: AbortSignal) => {
    L.debug("Setting up global method _okou");
    const okou = window._okou;
    if (!okou) {
      throw new Error("Platform lifecycle was not initialized");
    }

    window.addEventListener(
      ENABLE_DEBUG_LOGGER_EVENT,
      (event) => {
        if (
          !(event instanceof CustomEvent) ||
          typeof event.detail !== "string"
        ) {
          return;
        }
        set(extendDebugLoggerLocalStorage$, event.detail);
      },
      { signal },
    );

    Object.defineProperty(okou, "loggers", {
      configurable: true,
      enumerable: true,
      get() {
        return createDebugLoggers((name) => {
          window.dispatchEvent(
            new CustomEvent(ENABLE_DEBUG_LOGGER_EVENT, { detail: name }),
          );
        });
      },
    });
    okou.inspectLogs = () => {
      get(inspectLogInput$)?.click();
    };
    okou.getBuildCommitSha = getBuildCommitSha;
    okou.getBuildVersion = () => {
      return __OKOU_APP_VERSION__;
    };

    signal.addEventListener("abort", () => {
      L.debug("Cleaning up global debug methods");
      delete okou.loggers;
      delete okou.inspectLogs;
      delete okou.getBuildCommitSha;
      delete okou.getBuildVersion;
    });
  },
);
