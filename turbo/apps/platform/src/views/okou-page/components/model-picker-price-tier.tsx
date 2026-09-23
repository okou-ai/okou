import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import type { ModelPriceTier } from "./settings/provider-ui-config.ts";

export function PriceTierBadge({
  tier,
  description,
}: {
  tier: ModelPriceTier;
  description: string;
}) {
  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="shrink-0 cursor-help text-xs font-medium text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:decoration-muted-foreground">
              {tier}
            </span>
          }
        />
        <TooltipContent side="top" className="text-xs">
          {description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
