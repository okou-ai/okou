import type { ReactNode, UIEvent } from "react";
import { useLastLoadable, useSet } from "ccstate-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import type { ThreadResourceSection } from "../../signals/chat-page/thread-sidebar.ts";
import { openThreadArtifacts$ } from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import { ChatResourceLinks } from "./chat-resource-links.tsx";

export function ThreadResourceTabs({
  thread,
  section = "artifacts",
  artifactCount,
  hasMore,
  onScroll,
  children,
}: {
  readonly thread: ChatPanelSignals;
  readonly section?: ThreadResourceSection;
  readonly artifactCount: number | null;
  readonly hasMore: boolean;
  readonly onScroll: (event: UIEvent<HTMLElement>) => void;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  const selectSection = useSet(openThreadArtifacts$);
  const links = useLastLoadable(thread.resources.links$);
  return (
    <Tabs
      value={section}
      onValueChange={(value) => {
        if (value === "artifacts" || value === "links") {
          // Changing tabs keeps the thread's loaded catalog pages and fullscreen.
          selectSection(thread, value);
        }
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="shrink-0 border-b border-border/60 px-4 pb-4">
        <TabsList
          aria-label={t(($) => {
            return $.chat.resources.title;
          })}
        >
          <TabsTrigger value="artifacts">
            {t(($) => {
              return $.artifacts.sidebar.panelTitle;
            })}
            {artifactCount !== null && (
              <span className="text-xs font-normal tabular-nums text-muted-foreground">
                {formatLocalizedNumber(artifactCount)}
                {hasMore ? "+" : ""}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="links">
            {t(($) => {
              return $.chat.resources.links;
            })}
            {links.state === "hasData" && (
              <span className="text-xs font-normal tabular-nums text-muted-foreground">
                {formatLocalizedNumber(links.data.length)}
              </span>
            )}
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent
        value="artifacts"
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
      >
        {children}
      </TabsContent>
      <TabsContent
        value="links"
        className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
      >
        {links.state === "hasData" ? (
          links.data.length > 0 ? (
            <ChatResourceLinks thread={thread} showHeading={false} />
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {t(($) => {
                return $.chat.resources.emptyLinks;
              })}
            </p>
          )
        ) : links.state === "hasError" ? (
          <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
            <p>
              {t(($) => {
                return $.chat.resources.loadFailed;
              })}
            </p>
          </div>
        ) : (
          <p
            role="status"
            className="py-12 text-center text-sm text-muted-foreground"
          >
            {t(($) => {
              return $.chat.resources.loadingLinks;
            })}
          </p>
        )}
      </TabsContent>
    </Tabs>
  );
}
