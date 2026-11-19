interface WorkflowSlashToken {
  readonly name: string;
  readonly from: number;
  readonly to: number;
}

/** Ordinary workflow tokens are case-sensitive and whitespace-delimited. */
export function createWorkflowTokenMatcher(
  workflowNames: readonly string[],
): ((text: string) => WorkflowSlashToken[]) | null {
  if (workflowNames.length === 0) {
    return null;
  }
  const names = new Set(workflowNames);
  return (text) => {
    return Array.from(text.matchAll(/(?:^|\s)\/[^\s]+(?=$|\s)/g)).flatMap(
      (match) => {
        const token = match[0].trimStart();
        const name = token.slice(1);
        if (!names.has(name)) {
          return [];
        }
        const from = match.index + match[0].length - token.length;
        return [{ name, from, to: from + token.length }];
      },
    );
  };
}
