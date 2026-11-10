import { projectSchema } from "@okouai/api-contracts/validators/projects";
import { PlanningError, type Snapshot } from "./snapshot";

export function planProjects(
  snapshot: Snapshot,
  targetAgentId: string,
  block: (code: string, key: string) => void,
) {
  const agents = new Map(
    snapshot.agents.map((row) => {
      return [row.id, row];
    }),
  );
  const projects = new Map(
    snapshot.projects.map((row) => {
      return [row.id, row];
    }),
  );
  const projectGroups = new Map<
    string,
    {
      key: string;
      owner: string;
      sourceAgentId: string;
      targetName: string;
      existingSameNameProjectIds: string[];
      chats: Snapshot["chats"];
    }
  >();
  const projectNames = new Map<string, string>();
  for (const chat of [...snapshot.chats].sort((a, b) => {
    return a.id.localeCompare(b.id);
  })) {
    const source = agents.get(chat.agentId);
    if (!source) throw new PlanningError("ChatAgentOutsideScope");
    if (chat.projectId !== null) {
      const current = projects.get(chat.projectId);
      if (!current || current.owner !== chat.owner)
        throw new PlanningError("ChatProjectOutsideOwnerScope");
    }
    if (source.id === targetAgentId) continue;
    const key = `project:${chat.owner}:${source.id}`;
    if (
      !snapshot.members.some((member) => {
        return member.userId === chat.owner;
      })
    )
      block("OwnerNotInMembershipCache", key);
    let group = projectGroups.get(key);
    if (!group) {
      const name = source.displayName?.trim() || source.name;
      if (!projectSchema.shape.name.safeParse(name).success)
        block("InvalidTargetProjectName", key);
      group = {
        key,
        owner: chat.owner,
        sourceAgentId: source.id,
        targetName: name,
        existingSameNameProjectIds: snapshot.projects
          .filter((row) => {
            return row.owner === chat.owner && row.name === name;
          })
          .map((row) => {
            return row.id;
          })
          .sort(),
        chats: [],
      };
      if (group.existingSameNameProjectIds.length)
        block("ExistingProjectNameCollision", key);
      const nameKey = JSON.stringify([chat.owner, name]);
      const prior = projectNames.get(nameKey);
      if (prior !== undefined && prior !== key)
        block("TargetProjectNameCollision", key);
      else projectNames.set(nameKey, key);
      projectGroups.set(key, group);
    }
    group.chats.push(chat);
  }
  return [...projectGroups.values()].sort((a, b) => {
    return a.key.localeCompare(b.key);
  });
}
