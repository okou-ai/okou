import { ChevronRight, Ellipsis } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@okouai/ui";
import type { SandboxFilesSignals } from "../../signals/activity-page/sandbox-files.ts";
import {
  filesLocationLabel,
  filesLocationTokens,
  type FilesLocation,
} from "../../signals/activity-page/sandbox-files-location.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

function FilesAncestorMenu({
  signals,
  location,
}: {
  readonly signals: SandboxFilesSignals;
  readonly location: FilesLocation;
}) {
  const { t } = useTranslation();
  const navigate = useSet(signals.navigate$);
  const signal = useGet(pageSignal$);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="quiet"
            size="icon-xs"
            aria-label={t(($) => {
              return $.activity.detail.files.parentFolders;
            })}
          />
        }
      >
        <Ellipsis size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-72">
        {location.slice(0, -2).map((_part, index) => {
          const target = location.slice(0, index + 1);
          return (
            <DropdownMenuItem
              key={JSON.stringify(filesLocationTokens(target))}
              className="break-all whitespace-normal"
              onClick={() => {
                detach(navigate(target, signal), Reason.DomCallback);
              }}
            >
              {filesLocationLabel(target)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SandboxFilesBreadcrumb({
  signals,
}: {
  readonly signals: SandboxFilesSignals;
}) {
  const { t } = useTranslation();
  const location = useGet(signals.location$);
  const navigate = useSet(signals.navigate$);
  const signal = useGet(pageSignal$);
  const compact = location.length > 3;
  const visible = location
    .map((part, index) => {
      return { part, depth: index + 1 };
    })
    .filter(({ depth }) => {
      return !compact || depth > location.length - 2;
    });
  return (
    <nav
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
      aria-label={t(($) => {
        return $.activity.detail.files.currentFolder;
      })}
    >
      {location.length === 0 ? (
        <span aria-current="location" className="px-1 text-xs font-medium">
          /
        </span>
      ) : (
        <Button
          type="button"
          variant="quiet"
          size="xs"
          className="shrink-0 px-1.5 text-xs"
          aria-label={t(($) => {
            return $.activity.detail.files.root;
          })}
          onClick={() => {
            detach(navigate([], signal), Reason.DomCallback);
          }}
        >
          /
        </Button>
      )}
      {compact && (
        <>
          <ChevronRight
            size={12}
            className="shrink-0 text-muted-foreground"
            aria-hidden
          />
          <FilesAncestorMenu signals={signals} location={location} />
        </>
      )}
      {visible.map(({ part, depth }) => {
        const target = location.slice(0, depth);
        return (
          <div
            key={JSON.stringify(filesLocationTokens(target))}
            className="flex min-w-0 items-center gap-0.5"
          >
            <ChevronRight
              size={12}
              className="shrink-0 text-muted-foreground"
              aria-hidden
            />
            {depth === location.length ? (
              <span
                aria-current="location"
                className="min-w-0 truncate px-1 text-xs font-medium"
              >
                {part.displayName}
              </span>
            ) : (
              <Button
                type="button"
                variant="quiet"
                size="xs"
                className="min-w-0 px-1 text-xs"
                onClick={() => {
                  detach(navigate(target, signal), Reason.DomCallback);
                }}
              >
                <span className="truncate">{part.displayName}</span>
              </Button>
            )}
          </div>
        );
      })}
    </nav>
  );
}
