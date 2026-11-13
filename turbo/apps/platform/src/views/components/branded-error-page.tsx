import { Card } from "@okouai/ui";
import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { ProductBrandMark } from "./product-brand-mark.tsx";

export function BrandedErrorPage({
  title,
  description,
  brand = <ProductBrandMark size="compact" />,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly brand?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="fixed inset-0 flex h-viewport flex-col items-center overflow-y-auto bg-background pt-safe-offset-8 pr-safe-offset-6 pb-safe-offset-8 pl-safe-offset-6">
      <div className="my-auto flex w-[430px] max-w-full shrink-0 flex-col items-center gap-6">
        {brand}
        <Card className="w-full rounded-3xl px-6 py-7 sm:p-8" role="alert">
          <div className="flex items-start gap-3">
            <AlertCircle
              aria-hidden="true"
              size={20}
              strokeWidth={1.75}
              className="mt-1 shrink-0 text-destructive"
            />
            <div className="min-w-0 flex-1">
              <h1 className="text-lg leading-7 font-medium text-foreground">
                {title}
              </h1>
              <p className="mt-2 text-sm leading-5 text-muted-foreground">
                {description}
              </p>
              {children ? <div className="mt-6">{children}</div> : null}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
