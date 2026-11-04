import { useLastLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Lightbulb } from "lucide-react";
import { agentSuggestionFeedItems$ } from "../../signals/okou-page/agent-suggestion-session.ts";
import {
  AgentSuggestions,
  SuggestionSaveErrors,
} from "../okou-page/agent-suggestions.tsx";

function FeedEmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card px-6 py-12 text-center">
      <Lightbulb aria-hidden className="size-5 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.feed.emptyTitle;
        })}
      </p>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.feed.emptyDescription;
        })}
      </p>
    </div>
  );
}

function FeedSuggestions() {
  const { t } = useTranslation();
  const result = useLastLoadable(agentSuggestionFeedItems$);
  if (result.state === "loading") {
    return null;
  }
  if (result.state === "hasError") {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.global.errors.requestFailed;
        })}
      </p>
    );
  }
  if (result.data.length === 0) {
    return <FeedEmptyState />;
  }
  return <AgentSuggestions />;
}

export function FeedPage() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 bg-transparent px-4 pt-3 pb-0 sm:px-6 md:pt-10 md:pb-3">
        {/* The mobile top bar names the page, as on the other sidebar pages. */}
        <div className="mx-auto hidden max-w-[720px] md:block">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            {t(($) => {
              return $.feed.title;
            })}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t(($) => {
              return $.feed.description;
            })}
          </p>
        </div>
      </header>
      <main className="flex-1 overflow-auto px-4 pt-3 pb-safe-or-8 sm:px-6">
        <div className="mx-auto flex max-w-[720px] flex-col gap-4">
          <FeedSuggestions />
          <SuggestionSaveErrors />
        </div>
      </main>
    </div>
  );
}
