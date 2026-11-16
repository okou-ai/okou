import type { FeatureGuideMedia } from "@okouai/api-contracts/contracts/feature-guides";
import { OkouAvatar } from "@okouai/ui/components/ui/okou-avatar";
import { ArrowDown, ArrowRight, Bot } from "lucide-react";

export function FeatureGuideComparison({
  media,
}: {
  readonly media: Extract<FeatureGuideMedia, { type: "comparison" }>;
}) {
  return (
    <figure aria-label={media.label} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 rounded-xl bg-brand-off-white p-3 text-brand-charcoal sm:grid-cols-[1fr_auto_1fr] sm:p-5">
        <section aria-label={media.before.label} className="min-w-0">
          <p className="mb-2 text-sm font-medium text-brand-dark-gray sm:mb-3">
            {media.before.label}
          </p>
          <p className="mb-3 text-sm font-medium leading-snug sm:mb-4 sm:text-lg">
            {media.before.title}
          </p>
          <ul className="grid grid-cols-3 gap-2 sm:flex sm:flex-col sm:gap-3">
            {media.before.items.map((item) => {
              return (
                <li
                  key={item.title}
                  className="flex flex-col items-center gap-2 rounded-xl border border-brand-silver bg-white p-2 text-center sm:flex-row sm:gap-3 sm:p-3 sm:text-left"
                >
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-off-white text-brand-dark-gray sm:size-9">
                    <Bot className="size-4 sm:size-5" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="break-words text-xs font-medium sm:text-sm">
                      {item.title}
                    </p>
                    <p className="mt-1 hidden text-xs leading-relaxed text-brand-dark-gray sm:block">
                      {item.description}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
        <div
          aria-hidden="true"
          className="flex items-center justify-center text-brand-dark-gray"
        >
          <ArrowRight className="hidden size-5 sm:block" />
          <ArrowDown className="size-5 sm:hidden" />
        </div>
        <section aria-label={media.after.label} className="min-w-0">
          <p className="mb-2 text-sm font-medium text-brand-dark-gray sm:mb-3">
            {media.after.label}
          </p>
          <div className="flex flex-col items-center rounded-xl border border-brand-silver bg-white p-3 sm:p-4">
            <div className="flex w-full items-center justify-center gap-3 sm:flex-col sm:gap-0">
              <OkouAvatar
                size={64}
                motion="static"
                aria-hidden="true"
                className="size-10 shrink-0 sm:size-16"
              />
              <p className="text-sm font-medium leading-snug sm:mt-3 sm:text-center sm:text-lg">
                {media.after.title}
              </p>
            </div>
            <ArrowDown
              size={20}
              aria-hidden="true"
              className="my-2 size-4 text-brand-dark-gray sm:my-3 sm:size-5"
            />
            <ul className="grid w-full grid-cols-2 gap-2 sm:flex sm:flex-col sm:gap-3">
              {media.after.items.map((item) => {
                return (
                  <li
                    key={item.title}
                    className="rounded-lg bg-brand-off-white p-2 sm:p-3"
                  >
                    <p className="break-words text-xs font-medium sm:text-sm">
                      {item.title}
                    </p>
                    <p className="mt-1 hidden text-xs leading-relaxed text-brand-dark-gray sm:block">
                      {item.description}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      </div>
      <ul className="flex flex-col gap-2 text-xs leading-relaxed text-muted-foreground sm:hidden">
        {media.after.items.map((item) => {
          return (
            <li key={item.title} aria-label={item.title}>
              {item.description}
            </li>
          );
        })}
      </ul>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {media.note}
      </p>
      <figcaption className="text-xs text-muted-foreground">
        {media.caption}
      </figcaption>
    </figure>
  );
}
