import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SlidersHorizontal } from "lucide-react";
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";

import { LoadingSwitch } from "../../../components/loading-switch.tsx";

export function ConnectorPermissionRow({
  icon,
  label,
  labelSuffix,
  description,
  enabled,
  loading,
  disabled = false,
  showManage,
  isLast,
  onManage,
  onToggle,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly labelSuffix?: ReactNode;
  readonly description?: ReactNode;
  readonly enabled: boolean;
  readonly loading: boolean;
  readonly disabled?: boolean;
  readonly showManage: boolean;
  readonly isLast: boolean;
  readonly onManage?: () => void;
  readonly onToggle: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors">
        {icon}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              data-testid="connector-card-label"
              className="max-w-full shrink-0 truncate text-sm font-medium text-foreground"
            >
              {label}
            </span>
            {labelSuffix}
          </div>
          {description ? (
            <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
              {description}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {showManage ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      onClick={onManage}
                      variant="quiet"
                      size="icon-xs"
                      aria-label={t(
                        ($) => {
                          return $.connectors.card.managePermissionsFor;
                        },
                        { connector: label },
                      )}
                    >
                      <SlidersHorizontal size={15} />
                    </Button>
                  }
                />
                <TooltipContent side="top">
                  <p className="text-xs">
                    {t(($) => {
                      return $.connectors.card.managePermissions;
                    })}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          <LoadingSwitch
            checked={enabled}
            onCheckedChange={onToggle}
            loading={loading}
            disabled={disabled}
            ariaLabel={t(
              ($) => {
                return $.connectors.card.accessFor;
              },
              {
                action: enabled
                  ? t(($) => {
                      return $.connectors.actions.revoke;
                    })
                  : t(($) => {
                      return $.connectors.actions.grant;
                    }),
                connector: label,
              },
            )}
          />
        </div>
      </div>
      {!isLast ? <div className="mx-5 border-b border-border/50" /> : null}
    </>
  );
}
