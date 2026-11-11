import { createHash } from "node:crypto";
import {
  array,
  literal,
  object,
  string,
  uuid,
  type infer as zInfer,
} from "zod";
import { workflowNameSchema } from "@okouai/api-contracts/contracts/workflows";
import { PlanningError, type Snapshot } from "./snapshot";

type Agent = Snapshot["agents"][number];

const prefixSchema = string()
  .min(1)
  .max(12)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const agentPrefixesSchema = object({
  format: literal("single-agent-prefixes-v1"),
  orgId: string().min(1),
  prefixes: array(object({ agentId: uuid(), prefix: prefixSchema }).strict()),
}).strict();

export type AgentPrefixes = zInfer<typeof agentPrefixesSchema>;

export function parseAgentPrefixes(value: unknown): AgentPrefixes {
  const result = agentPrefixesSchema.safeParse(value);
  if (!result.success) throw new PlanningError("AgentPrefixesSchemaMismatch");
  return result.data;
}

function label(agent: Agent) {
  const value = agent.displayName?.trim() || agent.name.trim();
  if (!value) throw new PlanningError("AgentLabelRequired");
  return value;
}

function shortId(agent: Agent) {
  return agent.id.replaceAll("-", "").toLowerCase().slice(0, 8);
}

export function planNames(
  snapshot: Snapshot,
  targetAgentId: string,
  configured?: AgentPrefixes,
) {
  const agents = snapshot.agents
    .filter((row) => {
      return row.id !== targetAgentId;
    })
    .sort((a, b) => {
      return a.id.localeCompare(b.id);
    });
  const prefixes = configured
    ? [...configured.prefixes]
    : agents.map((agent) => {
        const slug = label(agent)
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/gu, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "-")
          .replace(/^-+|-+$/gu, "");
        return {
          agentId: agent.id,
          prefix: slug
            ? slug.slice(0, 12).replace(/-+$/u, "")
            : `a-${shortId(agent)}`,
        };
      });
  const prefixCounts = new Map<string, number>();
  for (const row of prefixes)
    prefixCounts.set(row.prefix, (prefixCounts.get(row.prefix) ?? 0) + 1);
  if (!configured) {
    for (const row of prefixes) {
      if (prefixCounts.get(row.prefix)! > 1) {
        const agent = agents.find((agent) => {
          return agent.id === row.agentId;
        })!;
        row.prefix = `${row.prefix.slice(0, 3).replace(/-+$/u, "")}-${shortId(agent)}`;
      }
    }
  }
  if (
    (configured && configured.orgId !== snapshot.orgId) ||
    prefixes.length !== agents.length ||
    new Set(
      prefixes.map((row) => {
        return row.agentId;
      }),
    ).size !== agents.length ||
    agents.some((agent) => {
      return !prefixes.some((row) => {
        return row.agentId === agent.id;
      });
    })
  )
    throw new PlanningError("AgentPrefixesScopeMismatch");
  if (
    new Set(
      prefixes.map((row) => {
        return row.prefix;
      }),
    ).size !== prefixes.length
  )
    throw new PlanningError("AgentPrefixCollision; supply --agent-prefixes");
  prefixes.sort((a, b) => {
    return a.agentId.localeCompare(b.agentId);
  });
  const labels = new Map<string, number>();
  for (const agent of agents) {
    const key = label(agent).toLowerCase();
    labels.set(key, (labels.get(key) ?? 0) + 1);
  }
  return {
    agentPrefixes: {
      format: "single-agent-prefixes-v1" as const,
      orgId: snapshot.orgId,
      prefixes,
    },
    projectNames: new Map(
      agents.map((agent) => {
        const name = label(agent);
        return [
          agent.id,
          labels.get(name.toLowerCase())! > 1
            ? `${name} (${shortId(agent)})`
            : name,
        ];
      }),
    ),
  };
}

export function workflowTargetName(
  prefix: string,
  sourceAgentId: string,
  workflowName: string,
) {
  const name = `${prefix}--wf-${workflowName}`;
  if (name.length <= 64 || !workflowNameSchema.safeParse(workflowName).success)
    return name;
  const hash = createHash("sha256")
    .update(JSON.stringify([sourceAgentId, workflowName]))
    .digest("hex")
    .slice(0, 8);
  const stem = workflowName
    .slice(0, 64 - prefix.length - 5 - 9)
    .replace(/-+$/u, "");
  return `${prefix}--wf-${stem}-${hash}`;
}
