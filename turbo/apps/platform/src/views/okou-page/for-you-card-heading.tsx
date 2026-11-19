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
    <header className="grid min-h-32 grid-cols-[minmax(0,1fr)_7rem] items-center gap-4 max-[360px]:grid-cols-[minmax(0,1fr)_5.75rem] max-[360px]:gap-2.5 sm:min-h-40 sm:grid-cols-[minmax(0,1fr)_11rem] sm:gap-6">
      <div className="min-w-0">
        {source && <div className="mb-3 flex min-w-0">{source}</div>}
        <h3
          id={`suggestion-title-${id}`}
          ref={active ? focusTitle : undefined}
          tabIndex={-1}
          className="text-xl font-semibold leading-8 text-foreground wrap-break-word focus:outline-none sm:text-2xl"
        >
          {title}
        </h3>
        {description && (
          <p className="mt-2 text-xs leading-5 text-muted-foreground wrap-break-word sm:text-sm sm:leading-6">
            {description}
          </p>
        )}
      </div>
      <div className="flex items-center justify-center p-2.5 max-[360px]:p-2 sm:p-3">
        {illustration && (
          <img
            data-slot="for-you-illustration"
            src={illustration}
            alt=""
            draggable={false}
            width={152}
            height={136}
            className="h-27 w-full select-none object-contain max-[360px]:h-25 sm:h-34"
          />
        )}
      </div>
    </header>
  );
}
