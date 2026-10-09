import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import type { ReactNode } from "react";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { ProductBrandMarkLink } from "./directed-shared.tsx";

export function ConnectorFlowCard({
  connectorIcon,
  iconContent,
  title,
  description,
  children,
}: {
  readonly connectorIcon: PublicConnectorCatalogIcon | undefined;
  readonly iconContent?: ReactNode;
  readonly title: string;
  readonly description: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-10 flex h-viewport flex-col items-center overflow-y-auto bg-background pt-safe-offset-8 pr-safe-offset-6 pb-safe-offset-8 pl-safe-offset-6 pointer-events-none">
      <div className="pointer-events-auto my-auto flex w-[430px] max-w-full shrink-0 flex-col items-center gap-12 rounded-[20px] border border-border bg-background px-6 py-12 text-center">
        <ProductBrandMarkLink />
        <div
          className="flex w-full flex-col items-center gap-4"
          aria-live="polite"
        >
          <div className="flex flex-col items-center gap-2.5">
            <h1 className="text-lg font-medium text-foreground">{title}</h1>
            <div className="flex items-center justify-center rounded-[10px] bg-muted p-2.5">
              {iconContent ?? <ConnectorIcon icon={connectorIcon} size={20} />}
            </div>
            <p className="w-64 max-w-full text-sm text-muted-foreground">
              {description}
            </p>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
