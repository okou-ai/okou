import type { WalletConnectionStatus } from "@okouai/api-contracts/contracts/wallet";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@okouai/ui";
import { Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ScopeReviewContent } from "./scope-review-modal.tsx";

export function WalletScopeReviewDialog({
  change,
  disabled,
  onReconnect,
}: {
  readonly change: NonNullable<WalletConnectionStatus["scopeChange"]>;
  readonly disabled: boolean;
  readonly onReconnect: () => void;
}) {
  const { t } = useTranslation();
  const description =
    change.reason === "workspace_scope_changed"
      ? t(($) => {
          return $.settings.wallet.workspaceScopeChanged;
        })
      : change.reason === "permissions_unknown"
        ? t(($) => {
            return $.settings.wallet.permissionsUnknown;
          })
        : undefined;
  return (
    <Dialog>
      <DialogTrigger render={<Button disabled={disabled} />}>
        {t(($) => {
          return $.connectors.card.reviewPermissions;
        })}
      </DialogTrigger>
      <DialogContent maxWidth="md" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <Wallet size={20} aria-hidden="true" />
            <DialogTitle>
              {t(
                ($) => {
                  return $.connectors.permissions.scopeReview.title;
                },
                {
                  connector: t(($) => {
                    return $.connectors.callback.linkLabel;
                  }),
                },
              )}
            </DialogTitle>
          </div>
        </DialogHeader>
        <ScopeReviewContent
          addedScopes={change.addedScopes}
          removedScopes={change.removedScopes}
          description={description}
        >
          <DialogClose
            render={
              <Button
                className="flex-1"
                disabled={disabled}
                onClick={onReconnect}
              />
            }
          >
            {t(($) => {
              return $.connectors.actions.reconnect;
            })}
          </DialogClose>
          <DialogClose render={<Button variant="outline" />}>
            {t(($) => {
              return $.connectors.actions.close;
            })}
          </DialogClose>
        </ScopeReviewContent>
      </DialogContent>
    </Dialog>
  );
}
