import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL } from "node:url";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  createPiAgentSessionForRuntime,
  createPiApiFirstAgentSessionForRuntime,
} from "../src/session-runtime.ts";

const mode = process.argv[2];
const repetitions = Number(process.argv[3] ?? 11);

if (!new Set(["api-first", "compare", "generic"]).has(mode)) {
  throw new Error(
    "usage: measure-api-first-services.mjs <api-first|compare|generic> [repetitions]",
  );
}
if (
  !Number.isSafeInteger(repetitions) ||
  repetitions < 2 ||
  repetitions > 100
) {
  throw new Error("repetitions must be an integer from 2 through 100");
}

const cwd = "/tmp/okou-pi-api-first-measure/workspace";
const agentDir = "/tmp/okou-pi-api-first-measure/agent";
const resourceSnapshot = {
  schemaVersion: 2,
  agentsFiles: [
    {
      path: `${cwd}/AGENTS.md`,
      content: "Use the fixed local API-first measurement fixture.",
    },
  ],
  skills: [
    {
      name: "measurement-skill",
      description: "Keep the fixed resource path representative.",
      filePath: `${agentDir}/skills/measurement-skill/SKILL.md`,
      baseDir: `${agentDir}/skills/measurement-skill`,
      scope: "user",
      disableModelInvocation: false,
    },
  ],
  memoryRecall: {
    status: "no-content",
    memoryStorageId: "measurement-memory",
    storageVersionId: "measurement-memory-version",
  },
};
const model = {
  provider: "openai",
  baseUrl: "http://127.0.0.1:1/v1",
  apiKey: "local-measurement-only",
  model: "gpt-5.6-terra",
  dialect: "openai-responses",
  transport: "sse",
  thinkingLevel: "high",
  serviceTier: "priority",
};

function summarize(values) {
  const sorted = [...values].sort((left, right) => {
    return left - right;
  });
  return {
    minMs: sorted[0],
    medianMs: sorted[Math.floor(sorted.length / 2)],
    maxMs: sorted.at(-1),
  };
}

async function sdkVersion() {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", entry), "utf8"),
  );
  return packageJson.version;
}

async function measureOnce(runMode) {
  const phases = [];
  const args = {
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd, { id: randomUUID() }),
    model,
    appendSystemPrompt: "Fixed caller instruction.",
    resourceSnapshot,
    onPreparationTiming(observation) {
      phases.push(observation);
    },
  };
  const startedAt = performance.now();
  const created =
    runMode === "api-first"
      ? await createPiApiFirstAgentSessionForRuntime(args)
      : await createPiAgentSessionForRuntime(args);
  const wallMs = performance.now() - startedAt;
  created.session.dispose();
  return { wallMs, phases };
}

const runsByMode = { "api-first": [], generic: [] };
const errors = [];
for (let index = 0; index < repetitions; index += 1) {
  const runModes =
    mode === "compare"
      ? index % 2 === 0
        ? ["generic", "api-first"]
        : ["api-first", "generic"]
      : [mode];
  for (const runMode of runModes) {
    try {
      runsByMode[runMode].push(await measureOnce(runMode));
    } catch (error) {
      errors.push({
        mode: runMode,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function summarizeMode(runs) {
  const warmRuns = runs.slice(1);
  const phaseNames = [
    ...new Set(
      warmRuns.flatMap((run) => {
        return run.phases.map((phase) => {
          return phase.phase;
        });
      }),
    ),
  ];
  const warmPhases = Object.fromEntries(
    phaseNames.map((phaseName) => {
      return [
        phaseName,
        summarize(
          warmRuns.flatMap((run) => {
            return run.phases
              .filter((phase) => {
                return phase.phase === phaseName;
              })
              .map((phase) => {
                return phase.durationMs;
              });
          }),
        ),
      ];
    }),
  );
  return {
    successfulRuns: runs.length,
    firstInvocation: runs[0]
      ? {
          wallMs: runs[0].wallMs,
          phases: Object.fromEntries(
            runs[0].phases.map((phase) => {
              return [phase.phase, phase.durationMs];
            }),
          ),
        }
      : null,
    warm: warmRuns.length
      ? {
          runs: warmRuns.length,
          wall: summarize(
            warmRuns.map((run) => {
              return run.wallMs;
            }),
          ),
          within40Ms: {
            runs: warmRuns.filter((run) => {
              return run.wallMs <= 40;
            }).length,
            total: warmRuns.length,
          },
          phases: warmPhases,
        }
      : null,
  };
}

process.stdout.write(
  `${JSON.stringify(
    {
      sdkVersion: await sdkVersion(),
      mode,
      repetitions,
      errors,
      fixture: {
        resourceSchemaVersion: resourceSnapshot.schemaVersion,
        agentsFiles: resourceSnapshot.agentsFiles.length,
        skills: resourceSnapshot.skills.length,
        memoryRecall: resourceSnapshot.memoryRecall.status,
        providerRequests: 0,
        toolExecutions: 0,
        compareOrder:
          mode === "compare"
            ? "alternating pairs; first pair generic then api-first"
            : null,
      },
      results: Object.fromEntries(
        Object.entries(runsByMode)
          .filter(([, runs]) => {
            return runs.length > 0;
          })
          .map(([runMode, runs]) => {
            return [runMode, summarizeMode(runs)];
          }),
      ),
    },
    null,
    2,
  )}\n`,
);
