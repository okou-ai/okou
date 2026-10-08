import { createHash, randomUUID } from "node:crypto";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { PiPreheatedResourceSnapshot } from "./api-types";
import { PI_MODEL_LIMIT_OVERRIDES } from "./model-limits";
import { createPiAgentSessionForRuntime } from "./session-runtime";
import type { PiAgentModelConfig } from "./types";

/** Fixed inputs: only the code that turns them into a session may vary. */
const PI_SESSION_CONSTRUCTION_CWD = "/home/user/workspace";
const PI_SESSION_CONSTRUCTION_AGENT_DIR = "/home/user/.pi/agent";
const PI_SESSION_CONSTRUCTION_MODEL: PiAgentModelConfig = {
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "session-construction-digest",
  model: "openai/gpt-6-luna",
  dialect: "openai-responses",
  transport: "sse",
  thinkingLevel: "max",
};

interface PiSessionConstructionProfile {
  readonly name: string;
  readonly resourceSnapshot: PiPreheatedResourceSnapshot;
}

/**
 * One profile per input-dependent branch that changes the prompt or the tool
 * loadout. Add a profile whenever the construction grows such a branch.
 */
const PI_SESSION_CONSTRUCTION_PROFILES: readonly PiSessionConstructionProfile[] =
  [
    {
      name: "no-memory",
      resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
    },
    {
      name: "memory-tools",
      resourceSnapshot: {
        schemaVersion: 2,
        agentsFiles: [],
        skills: [],
        memoryRecall: {
          status: "no-content",
          memoryStorageId: "session-construction-digest",
          storageVersionId: "session-construction-digest",
        },
      },
    },
  ];

export interface PiSessionConstructionProfileDocument {
  readonly name: string;
  readonly systemPrompt: string;
  readonly tools: readonly unknown[];
}

export interface PiSessionConstructionDocument {
  readonly version: 2;
  readonly modelLimitOverrides: typeof PI_MODEL_LIMIT_OVERRIDES;
  readonly profiles: readonly PiSessionConstructionProfileDocument[];
}

/**
 * Capture verified model-limit corrections alongside the constructed prompt
 * and ordered tool schemas. Limits-only changes must also invalidate stale
 * installed CLIs, even when their prompt/tool profiles are identical. The
 * returned document owns its limit snapshot, not the live runtime registry.
 */
export async function computePiSessionConstructionDocument(): Promise<PiSessionConstructionDocument> {
  const profiles: PiSessionConstructionProfileDocument[] = [];
  for (const profile of PI_SESSION_CONSTRUCTION_PROFILES) {
    const created = await createPiAgentSessionForRuntime({
      cwd: PI_SESSION_CONSTRUCTION_CWD,
      agentDir: PI_SESSION_CONSTRUCTION_AGENT_DIR,
      sessionManager: SessionManager.inMemory(PI_SESSION_CONSTRUCTION_CWD, {
        id: randomUUID(),
      }),
      model: PI_SESSION_CONSTRUCTION_MODEL,
      appendSystemPrompt: null,
      resourceSnapshot: profile.resourceSnapshot,
    });
    try {
      profiles.push({
        name: profile.name,
        systemPrompt: created.session.systemPrompt,
        tools: created.session.agent.state.tools.map((tool) => {
          return JSON.parse(
            JSON.stringify({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            }),
          ) as unknown;
        }),
      });
    } finally {
      created.session.dispose();
    }
  }
  return {
    version: 2,
    modelLimitOverrides: structuredClone(PI_MODEL_LIMIT_OVERRIDES),
    profiles,
  };
}

/** Lowercase hex SHA-256 over the canonical JSON of the document. */
export async function computePiSessionConstructionDigest(): Promise<string> {
  const document = await computePiSessionConstructionDocument();
  return createHash("sha256")
    .update(JSON.stringify(document), "utf8")
    .digest("hex");
}
