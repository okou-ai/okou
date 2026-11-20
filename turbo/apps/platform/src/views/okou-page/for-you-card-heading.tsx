import type { ReactNode } from "react";
import { useLastResolved, useSet } from "ccstate-react";
import { focusSuggestionTitleOnRef$ } from "../../signals/okou-page/agent-suggestion-session.ts";
import { forYouIllustrations$ } from "../../signals/okou-page/for-you-artwork.ts";

export function ForYouCardHeading({
  id,
  title,
  description,
  source,
  active,
}: {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly source: ReactNode;
  readonly active: boolean;
}) {
  const focusTitle = useSet(focusSuggestionTitleOnRef$);
  const illustration = useLastResolved(forYouIllustrations$)?.[id];
  return (
    <header className="grid grid-cols-[minmax(0,1fr)_7rem] items-start gap-4 max-[360px]:grid-cols-[minmax(0,1fr)_5.75rem] max-[360px]:gap-2.5 sm:grid-cols-[minmax(0,1fr)_11rem] sm:gap-6">
      <div className="min-w-0">
        {source && <div className="mb-2.5 flex min-w-0">{source}</div>}
        <h3
          id={`suggestion-title-${id}`}
          ref={active ? focusTitle : undefined}
          tabIndex={-1}
          className="text-lg font-semibold leading-7 text-foreground wrap-break-word focus:outline-none sm:text-xl sm:leading-8"
        >
          {title}
        </h3>
        {description && (
          <p className="mt-3 text-sm leading-6 text-muted-foreground wrap-break-word">
            {description}
          </p>
        )}
      </div>
      <div className="relative ml-2.5 self-stretch max-[360px]:ml-2 sm:ml-3">
        {/* Decorative artwork follows the copy height without stretching it. */}
        {illustration && (
          <img
            data-slot="for-you-illustration"
            src={illustration}
            alt=""
            draggable={false}
            width={152}
            height={136}
            className="absolute inset-0 m-auto h-full max-h-27 w-full select-none object-contain object-right max-[360px]:max-h-25 sm:max-h-34"
          />
        )}
      </div>
    </header>
  );
}
