import { DropdownMenuItem } from "@okouai/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { History, Loader2, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ArtifactCreationSourceScope } from "../../signals/artifact-creation-source.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";

export function ArtifactCreationSourceItem({
  artifactId,
  scope,
}: {
  readonly artifactId: string;
  readonly scope: ArtifactCreationSourceScope;
}) {
  const { t } = useTranslation();
  const result = useLoadable(scope.source$);
  const retry = useSet(scope.open$);
  const pageSignal = useGet(pageSignal$);
  const source =
    result.state === "hasData" && result.data?.artifactId === artifactId
      ? result.data.source
      : null;
  const label = t(($) => {
    return $.artifacts.actions.viewCreationSource;
  });
  if (source) {
    return (
      <DropdownMenuItem
        render={
          <Link
            pathname={ROUTES.chat}
            options={{
              pathParams: { threadId: source.chatThreadId },
              hash: source.runId ? `run-${source.runId}` : undefined,
            }}
          />
        }
      >
        <History size={14} />
        {label}
      </DropdownMenuItem>
    );
  }
  const failed = result.state === "hasError";
  const loading = result.state === "loading";
  return (
    <DropdownMenuItem
      disabled={!failed}
      aria-busy={loading}
      closeOnClick={false}
      title={
        !failed && !loading
          ? t(($) => {
              return $.artifacts.actions.creationSourceUnavailable;
            })
          : undefined
      }
      onClick={() => {
        detach(
          retry(artifactId, pageSignal),
          Reason.DomCallback,
          "retry artifact creation source",
        );
      }}
    >
      {loading ? (
        <Loader2 size={14} className="animate-spin" />
      ) : failed ? (
        <RotateCw size={14} />
      ) : (
        <History size={14} />
      )}
      {label}
      {failed &&
        ` — ${t(($) => {
          return $.artifacts.actions.retry;
        })}`}
    </DropdownMenuItem>
  );
}
