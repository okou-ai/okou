import { ArrowRight, UsersRound } from "lucide-react";
import { BrandGoogleDocs, BrandGoogleSheets, cn } from "@okouai/ui";
import {
  platformOkouWordmarkDarkImg,
  platformOkouWordmarkLightImg,
} from "../../lib/static-assets.ts";

export function GoogleWorkspaceGuideIllustration({
  stepIndex,
}: {
  readonly stepIndex: number;
}) {
  const stageClassName = (index: number) => {
    return cn(
      "flex h-14 w-12 shrink-0 items-center justify-center rounded-xl border sm:h-20 sm:w-24",
      index === stepIndex
        ? "border-primary/40 bg-primary/10 text-brand-text"
        : "border-control-border bg-control-surface text-muted-foreground",
    );
  };

  return (
    <div
      aria-hidden="true"
      className="flex items-center justify-center gap-1 py-4 sm:gap-3 sm:py-6"
    >
      <div className={stageClassName(0)}>
        <img
          src={platformOkouWordmarkDarkImg}
          alt=""
          className="w-10 sm:w-16 dark:hidden"
        />
        <img
          src={platformOkouWordmarkLightImg}
          alt=""
          className="hidden w-10 sm:w-16 dark:block"
        />
      </div>
      <ArrowRight className="size-3 shrink-0 text-muted-foreground sm:size-4" />
      <div className={stageClassName(1)}>
        <BrandGoogleDocs size={22} />
        <BrandGoogleSheets size={22} />
      </div>
      <ArrowRight className="size-3 shrink-0 text-muted-foreground sm:size-4" />
      <div className={stageClassName(2)}>
        <UsersRound className="size-6 sm:size-8" />
      </div>
    </div>
  );
}
