/** Canonical name of the organization default agent. */
export const DEFAULT_AGENT_DISPLAY_NAME = "Okou";

export interface BrandPresentation {
  readonly [key: string]: string;
  readonly assistantName: "Okou";
  readonly brandName: "Okou";
  readonly contactEmail: "contact@okou.ai";
  readonly supportEmail: "support@okou.ai";
}

export const BRAND_PRESENTATION: BrandPresentation = Object.freeze({
  assistantName: "Okou",
  brandName: "Okou",
  contactEmail: "contact@okou.ai",
  supportEmail: "support@okou.ai",
});

export function agentDisplayName(args: {
  readonly agentId: string;
  readonly defaultAgentId: string | null;
  readonly displayName: string | null;
}): string | null {
  if (args.agentId !== args.defaultAgentId) {
    return args.displayName;
  }

  return DEFAULT_AGENT_DISPLAY_NAME;
}
