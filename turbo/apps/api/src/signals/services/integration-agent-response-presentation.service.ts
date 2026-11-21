export function integrationAdmissionFailurePresentation(args: {
  readonly agentLabel: string | undefined;
  readonly replyToMention?: string;
}): { readonly footerText: string | undefined } {
  const parts: string[] = [];
  if (args.agentLabel) {
    parts.push(`Sent via ${args.agentLabel}`);
  }
  if (args.replyToMention) {
    parts.push(`Reply to ${args.replyToMention}`);
  }
  return {
    footerText: parts.length > 0 ? parts.join(" · ") : undefined,
  };
}

export function integrationAgentResponsePresentation(args: {
  readonly agentLabel: string | undefined;
  readonly replyToMention?: string;
}): { readonly footerText: string | undefined } {
  const parts: string[] = [];
  if (args.agentLabel) {
    parts.push(`Responded by ${args.agentLabel}`);
  }
  if (args.replyToMention) {
    parts.push(`Reply to ${args.replyToMention}`);
  }

  return {
    footerText: parts.length > 0 ? parts.join(" · ") : undefined,
  };
}
