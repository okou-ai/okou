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
      <div className="grid grid-cols-1 gap-4 rounded-xl bg-brand-off-white p-4 text-brand-charcoal sm:grid-cols-[1fr_auto_1fr] sm:gap-3 sm:p-5">
        <section aria-label={media.before.label} className="min-w-0">
          <p className="mb-3 text-sm font-medium text-brand-dark-gray">
            {media.before.label}
          </p>
          <p className="mb-4 text-lg font-medium leading-snug">
            {media.before.title}
          </p>
          <ul className="flex flex-col gap-3">
            {media.before.items.map((item) => {
              return (
                <li
                  key={item.title}
                  className="flex items-center gap-3 rounded-xl border border-brand-silver bg-white p-3"
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-off-white text-brand-dark-gray">
                    <Bot size={20} aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-brand-dark-gray">
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
          <p className="mb-3 text-sm font-medium text-brand-dark-gray">
            {media.after.label}
          </p>
          <div className="flex flex-col items-center rounded-xl border border-brand-silver bg-white p-4">
            <OkouAvatar size={64} motion="static" aria-hidden="true" />
            <p className="mt-3 text-center text-lg font-medium leading-snug">
              {media.after.title}
            </p>
            <ArrowDown
              size={20}
              aria-hidden="true"
              className="my-3 text-brand-dark-gray"
            />
            <ul className="flex w-full flex-col gap-3">
              {media.after.items.map((item) => {
                return (
                  <li
                    key={item.title}
                    className="rounded-lg bg-brand-off-white p-3"
                  >
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-brand-dark-gray">
                      {item.description}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {media.note}
      </p>
      <figcaption className="text-xs text-muted-foreground">
        {media.caption}
      </figcaption>
    </figure>
  );
}
