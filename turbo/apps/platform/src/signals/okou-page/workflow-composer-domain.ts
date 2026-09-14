import type { WorkflowSummary } from "@okouai/api-contracts/contracts/workflows";

export function findWorkflowQueryMatches(
  workflows: readonly ComposerSlashWorkflow[],
  query: string,
): readonly ComposerSlashWorkflowMatch[] {
  const normalizedQuery = query.toLowerCase();
  const matches: {
    workflow: ComposerSlashWorkflowMatch;
    rank: number;
    skippedCharacters: number;
    start: number;
  }[] = [];

  for (const workflow of workflows) {
    const normalizedName = workflow.name.toLowerCase();
    const start = normalizedName.indexOf(normalizedQuery);
    if (start !== -1) {
      matches.push({
        workflow: {
          ...workflow,
          matchRanges: query ? [{ start, end: start + query.length }] : [],
        },
        rank: normalizedName === normalizedQuery ? 0 : start === 0 ? 1 : 2,
        skippedCharacters: 0,
        start,
      });
      continue;
    }
    if (normalizedQuery.length >= 3) {
      const match = findWorkflowSubsequence(normalizedName, normalizedQuery);
      if (match) {
        matches.push({
          workflow: { ...workflow, matchRanges: match.ranges },
          rank: 3,
          skippedCharacters: match.skippedCharacters,
          start: match.start,
        });
      }
    }
  }

  return matches
    .sort((left, right) => {
      if (left.rank !== 3 || right.rank !== 3) {
        return left.rank - right.rank;
      }
      // Prefer compact abbreviations, then earlier matches and shorter names.
      return (
        left.skippedCharacters - right.skippedCharacters ||
        left.start - right.start ||
        left.workflow.name.length - right.workflow.name.length
      );
    })
    .map((match) => {
      return match.workflow;
    });
}

function findWorkflowSubsequence(
  name: string,
  query: string,
): {
  readonly ranges: readonly WorkflowMatchRange[];
  readonly skippedCharacters: number;
  readonly start: number;
} | null {
  const ranges: WorkflowMatchRange[] = [];
  let offset = 0;
  let skippedCharacters = 0;
  let matchStart = 0;

  // Keep numeric identifiers contiguous while allowing letters to skip ahead.
  for (const [part] of query.matchAll(/\d+|\D/g)) {
    const start = name.indexOf(part, offset);
    if (start === -1) {
      return null;
    }
    if (ranges.length === 0) {
      matchStart = start;
    } else {
      skippedCharacters += start - offset;
    }
    offset = start + part.length;
    const previous = ranges.at(-1);
    if (previous?.end === start) {
      ranges[ranges.length - 1] = { start: previous.start, end: offset };
    } else {
      ranges.push({ start, end: offset });
    }
  }

  return { ranges, skippedCharacters, start: matchStart };
}

export interface SlashWorkflowRange {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export interface ComposerSlashWorkflow {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly token: string;
}

interface WorkflowMatchRange {
  readonly start: number;
  readonly end: number;
}

export interface ComposerSlashWorkflowMatch extends ComposerSlashWorkflow {
  readonly matchRanges: readonly WorkflowMatchRange[];
}

export function findActiveSlashWorkflowRange(
  value: string,
  caretIndex: number,
): SlashWorkflowRange | null {
  if (caretIndex < 0 || caretIndex > value.length) {
    return null;
  }

  const beforeCaret = value.slice(0, caretIndex);
  const match = /(?:^|\s)\/((?:create\s+[a-z]*)|[a-z0-9-]*)$/i.exec(
    beforeCaret,
  );
  if (!match) {
    return null;
  }

  const query = match[1] ?? "";
  const slashOffset = match[0].lastIndexOf("/");
  const start = beforeCaret.length - match[0].length + slashOffset;
  return { start, end: caretIndex, query };
}

export function workflowTokenPattern(
  workflowNames: readonly string[],
): RegExp | null {
  if (workflowNames.length === 0) {
    return null;
  }

  const escaped = workflowNames.map((name) => {
    return name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  });
  return new RegExp(`(?:^|\\s)/(?:${escaped.join("|")})(?=$|\\s)`, "g");
}

export function buildComposerSlashWorkflows({
  agentId,
  workflows,
}: {
  readonly agentId: string | null | undefined;
  readonly workflows: readonly WorkflowSummary[];
}): readonly ComposerSlashWorkflow[] {
  if (!agentId) {
    return [];
  }

  return workflows
    .filter((workflow) => {
      return (
        workflow.agentId === agentId &&
        (workflow.shadowedBy === null || workflow.shadowedBy === undefined)
      );
    })
    .map((workflow) => {
      const name = workflow.name;
      return {
        id: workflow.id,
        name,
        displayName: workflow.displayName,
        description: workflow.description,
        token: `/${name}`,
      };
    });
}
