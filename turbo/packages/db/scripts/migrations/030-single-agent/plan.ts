import { workflowNameSchema } from "@okouai/api-contracts/contracts/workflows";
import { planProjects } from "./plan-projects";
import {
  planNames,
  workflowTargetName,
  type AgentPrefixes,
} from "./plan-names";
import { PlanningError, type Snapshot } from "./snapshot";

type Agent = Snapshot["agents"][number];
type Workflow = Snapshot["workflows"][number];
type Blocker = { code: string; key: string };

export function plan(
  snapshot: Snapshot,
  orgId: string,
  inventorySha256: string,
  configuredPrefixes?: AgentPrefixes,
) {
  if (snapshot.orgId !== orgId)
    throw new PlanningError("OrganizationScopeMismatch");
  const agents = new Map(
    snapshot.agents.map((row) => {
      return [row.id, row];
    }),
  );
  const members = new Map(
    snapshot.members.map((row) => {
      return [row.userId, row];
    }),
  );
  const workflows = new Map(
    snapshot.workflows.map((row) => {
      return [row.id, row];
    }),
  );
  const personal = new Map(
    snapshot.personalInstructions.map((row) => {
      return [row.userId, row];
    }),
  );
  const chats = new Map(
    snapshot.chats.map((row) => {
      return [row.id, row];
    }),
  );
  const destination =
    snapshot.defaultAgentId && agents.get(snapshot.defaultAgentId);
  if (!destination || destination.visibility !== "public")
    throw new PlanningError("PublicDefaultAgentRequired");
  const naming = planNames(snapshot, destination.id, configuredPrefixes);
  const prefixes = new Map(
    naming.agentPrefixes.prefixes.map((row) => {
      return [row.agentId, row.prefix];
    }),
  );
  const blockers: Blocker[] = [];
  const block = (code: string, key: string) => {
    blockers.push({ code, key });
  };
  const ownerCheck = (owner: string, key: string) => {
    if (!members.has(owner)) block("OwnerNotInMembershipCache", key);
  };
  const names = new Map<string, string>();
  for (const workflow of snapshot.workflows) {
    if (!agents.has(workflow.agentId))
      throw new PlanningError("WorkflowAgentOutsideScope");
    if (workflow.agentId === destination.id)
      names.set(workflow.name, "default-namespace");
  }
  const reserve = (name: string, group: string, key: string) => {
    if (!workflowNameSchema.safeParse(name).success)
      block("InvalidTargetWorkflowName", key);
    const prior = names.get(name);
    if (prior !== undefined && prior !== group)
      block("TargetNameCollision", key);
    else names.set(name, group);
  };
  const canWriteAgent = (agent: Agent, userId: string) => {
    return (
      agent.owner === userId ||
      (agent.visibility === "public" && members.get(userId)?.role === "admin")
    );
  };
  const rights = (
    workflow: Pick<
      Workflow,
      "owner" | "visibility" | "official" | "officialState"
    >,
    agent: Agent,
    userId: string,
  ) => {
    const visible =
      (workflow.official === null || workflow.officialState === "installed") &&
      (workflow.owner === userId ||
        (workflow.visibility === "public" &&
          (agent.visibility === "public" || agent.owner === userId)));
    return {
      view: visible,
      manage:
        visible &&
        workflow.official === null &&
        (workflow.visibility === "private"
          ? workflow.owner === userId
          : canWriteAgent(agent, userId)),
      publish:
        visible &&
        workflow.official === null &&
        workflow.visibility === "private" &&
        workflow.owner === userId &&
        canWriteAgent(agent, userId),
    };
  };
  const movedWorkflows = snapshot.workflows
    .filter((row) => {
      return row.agentId !== destination.id;
    })
    .sort((a, b) => {
      return a.id.localeCompare(b.id);
    })
    .map((workflow) => {
      const source = agents.get(workflow.agentId)!;
      const name = workflowTargetName(
        prefixes.get(source.id)!,
        source.id,
        workflow.name,
      );
      const key = `workflow:${workflow.id}`;
      reserve(name, `workflow:${source.id}:${workflow.name}`, key);
      ownerCheck(workflow.owner, key);
      if (workflow.official !== null) block("NonDefaultOfficialWorkflow", key);
      if (workflow.bundle === null) block("MissingWorkflowBundle", key);
      const target = {
        ...workflow,
        visibility:
          source.visibility === "private"
            ? ("private" as const)
            : workflow.visibility,
      };
      const permissionChanges = [...members.keys()].sort().flatMap((userId) => {
        const before = rights(workflow, source, userId);
        const after = rights(target, destination, userId);
        const changed = (["view", "manage", "publish"] as const).filter(
          (key) => {
            return before[key] !== after[key];
          },
        );
        if (!changed.length) return [];
        const acceptedChanges = changed.filter((key) => {
          return source.visibility === "private" && key !== "publish";
        });
        const unresolvedChanges = changed.filter((key) => {
          return !acceptedChanges.includes(key);
        });
        return [{ userId, before, after, acceptedChanges, unresolvedChanges }];
      });
      if (
        permissionChanges.some((row) => {
          return row.unresolvedChanges.length > 0;
        })
      )
        block("WorkflowRightsChange", key);
      return {
        key,
        source: workflow,
        targetAgentId: destination.id,
        targetName: name,
        targetOwner: target.owner,
        targetVisibility: target.visibility,
        permissionChanges,
        republishBundle: true,
      };
    });
  const targetScopes = new Set<string>();
  for (const moved of movedWorkflows) {
    const scope = JSON.stringify([
      moved.targetName,
      moved.targetVisibility,
      moved.targetVisibility === "private" ? moved.targetOwner : null,
    ]);
    if (targetScopes.has(scope))
      block("TargetWorkflowScopeCollision", moved.key);
    else targetScopes.add(scope);
  }
  const convertedInstructions = snapshot.agents
    .filter((row) => {
      return row.id !== destination.id;
    })
    .sort((a, b) => {
      return a.id.localeCompare(b.id);
    })
    .map((source) => {
      const key = `agent-instructions:${source.id}`;
      const name = `${prefixes.get(source.id)!}--instruction`;
      reserve(name, key, key);
      ownerCheck(source.owner, key);
      if (source.instructions.bundle === null)
        block("MissingAgentInstructionsBundle", key);
      const maintenanceChanges = [...members.keys()].sort().filter((userId) => {
        const before = canWriteAgent(source, userId);
        const after =
          source.visibility === "private"
            ? source.owner === userId
            : canWriteAgent(destination, userId);
        return before !== after;
      });
      if (maintenanceChanges.length)
        block("InstructionWorkflowRightsChange", key);
      return {
        key,
        sourceAgentId: source.id,
        sourceRevision: source.revision,
        content: source.instructions,
        owner: source.owner,
        visibility: source.visibility,
        targetAgentId: destination.id,
        targetName: name,
        maintenanceChanges,
        automaticallyInvoke: false,
      };
    });
  if (destination.instructions.bundle === null)
    block("MissingPublicInstructionsBundle", destination.id);
  const personalInstructions = [...snapshot.members]
    .sort((a, b) => {
      return a.userId.localeCompare(b.userId);
    })
    .map((member) => {
      const saved = personal.get(member.userId);
      return {
        userId: member.userId,
        action: saved ? "preserve" : "initialize-once",
        existing: saved ?? null,
        sourceAgentId: destination.id,
        sourceRevision: destination.revision,
        sourceContent: destination.instructions,
      };
    });
  const projectGroups = planProjects(
    snapshot,
    destination.id,
    naming.projectNames,
    block,
  );
  const targets = new Map(
    movedWorkflows.map((row) => {
      return [
        row.source.id,
        { ...row.source, visibility: row.targetVisibility },
      ];
    }),
  );
  const ownerWorkflowAccess = (workflow: Workflow, owner: string) => {
    return {
      before: rights(workflow, agents.get(workflow.agentId)!, owner).view,
      after: rights(targets.get(workflow.id)!, destination, owner).view,
    };
  };
  const automations = [...snapshot.automations]
    .sort((a, b) => {
      return a.id.localeCompare(b.id);
    })
    .flatMap((automation) => {
      const workflow = workflows.get(automation.workflowId);
      if (!workflow) throw new PlanningError("AutomationWorkflowOutsideScope");
      if (workflow.agentId === destination.id) return [];
      const key = `automation:${automation.id}`;
      ownerCheck(automation.owner, key);
      const workflowAccess = ownerWorkflowAccess(workflow, automation.owner);
      if (!workflowAccess.after)
        block("AutomationOwnerCannotAccessTargetWorkflow", key);
      return [
        {
          ...automation,
          targetAgentId: destination.id,
          workflowAccess,
          preserveIdentityAndState: true,
        },
      ];
    });
  const automationThreads = snapshot.automationThreads
    .flatMap((thread) => {
      const workflow = workflows.get(thread.workflowId);
      if (!workflow)
        throw new PlanningError("AutomationThreadWorkflowOutsideScope");
      if (workflow.agentId === destination.id) return [];
      const key = `automation-thread:${thread.id}`;
      ownerCheck(thread.owner, key);
      const workflowAccess = ownerWorkflowAccess(workflow, thread.owner);
      if (!workflowAccess.after)
        block("AutomationThreadOwnerCannotAccessTargetWorkflow", key);
      if (thread.chatThreadId !== null) {
        const chat = chats.get(thread.chatThreadId);
        if (!chat || chat.owner !== thread.owner)
          block("AutomationChatOutsideOwnerAgentScope", key);
      }
      return [{ ...thread, workflowAccess }];
    })
    .sort((a, b) => {
      return a.id.localeCompare(b.id);
    });
  return {
    format: "single-agent-plan-v3",
    executable: false,
    privateAgentWorkflowPolicy: "private-preserve-workflow-owner",
    agentPrefixes: naming.agentPrefixes,
    scope: { orgId, target: snapshot.target, database: snapshot.database },
    capturedAt: snapshot.capturedAt,
    inventorySha256,
    targetAgentId: destination.id,
    summary: {
      workflowMoves: movedWorkflows.length,
      instructionConversions: convertedInstructions.length,
      personalInitializations: personalInstructions.filter((row) => {
        return row.action === "initialize-once";
      }).length,
      personalValuesPreserved: personalInstructions.filter((row) => {
        return row.action === "preserve";
      }).length,
      projectGroups: projectGroups.length,
      chatMoves: projectGroups.reduce((sum, row) => {
        return sum + row.chats.length;
      }, 0),
      automations: automations.length,
      enabledAutomations: automations.filter((row) => {
        return row.enabled;
      }).length,
    },
    movedWorkflows,
    convertedInstructions,
    personalInstructions,
    projectGroups,
    automations,
    automationThreads,
    blockers: blockers.sort((a, b) => {
      return a.key.localeCompare(b.key) || a.code.localeCompare(b.code);
    }),
    requiredBeforeApply: [
      "Live membership, per-member mode and converted-Instruction publication rights verification; cache is not authority",
      "Source bundle download and byte/content-limit verification; references alone are not acceptance",
      "Provenance review of earlier automatic personal seed rows; all saved rows are preserved in this plan",
      "Authored name references, account permissions, external routes and dependent FK inventory",
      "Native continuation, queued inputs, Automation listener/delivery state and lifecycle projections",
      "Versioned apply/recovery implementation and integrated acceptance under #45473",
    ],
  };
}
