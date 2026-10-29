import type { WhatsappLinkCodeResponse } from "@okouai/api-contracts/contracts/integrations-whatsapp";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { Button, buttonVariants, surfaceVariants } from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import {
  whatsappLinkStatus$,
  whatsappConnectDialogOpen$,
  setWhatsappConnectDialogOpen$,
  createWhatsappLinkCode$,
  disconnectWhatsapp$,
} from "../../signals/okou-page/whatsapp.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ConnectedIndicator } from "./components/connected-indicator.tsx";
import { ProviderCardMenu } from "./components/provider-card-menu.tsx";
import { WhatsappMark } from "./components/whatsapp-mark.tsx";
import { PhoneNumberCopyButton } from "./agentphone-connect-dialog.tsx";

function WhatsappConnectContent({
  phone,
  code,
  loading,
  failed,
  onGenerate,
}: {
  readonly phone: string | null | undefined;
  readonly code: WhatsappLinkCodeResponse | null;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly onGenerate: () => void;
}) {
  const { t } = useTranslation();
  const href =
    phone && code
      ? `https://wa.me/${phone.replace(/^\+/u, "")}?text=${encodeURIComponent(code.code)}`
      : null;
  return (
    <DialogContent smMaxWidth="lg">
      <DialogHeader>
        <DialogTitle>
          {t(($) => {
            return $.works.whatsapp.connect;
          })}
        </DialogTitle>
        <DialogDescription>
          {t(($) => {
            return $.works.whatsapp.instructions;
          })}
        </DialogDescription>
      </DialogHeader>
      {loading ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t(($) => {
            return $.works.whatsapp.loading;
          })}
        </p>
      ) : null}
      {failed ? (
        <p className="text-sm text-destructive" role="alert">
          {t(($) => {
            return $.works.whatsapp.codeError;
          })}
        </p>
      ) : null}
      {href && code && phone ? (
        <div className="flex flex-col items-center gap-4">
          <div className="rounded-xl bg-gray-50 p-3 max-sm:hidden pointer-coarse:hidden">
            <QRCodeSVG
              value={href}
              size={160}
              level="M"
              marginSize={1}
              aria-label={t(($) => {
                return $.works.whatsapp.qrTitle;
              })}
              data-testid="whatsapp-link-qr"
              data-whatsapp-href={href}
            />
          </div>
          <p className="font-mono text-xl tracking-widest">{code.code}</p>
          <PhoneNumberCopyButton phoneNumber={phone} />
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants()}
          >
            {t(($) => {
              return $.works.whatsapp.open;
            })}
          </a>
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.works.whatsapp.expires;
            })}
          </p>
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.works.whatsapp.markets;
        })}
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={loading}
        onClick={onGenerate}
      >
        {t(($) => {
          return $.works.whatsapp.regenerate;
        })}
      </Button>
    </DialogContent>
  );
}

export function WhatsappCard() {
  const { t } = useTranslation();
  const statusLoadable = useLastLoadable(whatsappLinkStatus$);
  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const [codeLoadable, createCode] = useLoadableSet(createWhatsappLinkCode$);
  const [disconnectLoadable, disconnect] = useLoadableSet(disconnectWhatsapp$);
  const signal = useGet(pageSignal$);
  const open = useGet(whatsappConnectDialogOpen$);
  const setOpen = useSet(setWhatsappConnectDialogOpen$);
  const code = codeLoadable.state === "hasData" ? codeLoadable.data : null;
  const phone = status?.agentPhoneNumber;
  const generateCode = () => {
    return detach(createCode(signal), Reason.DomCallback);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div
        data-slot="integration-card"
        className={surfaceVariants({ className: "flex flex-col" })}
      >
        <div className="flex items-center gap-4 p-4">
          <WhatsappMark size={28} className="shrink-0 text-green-600" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.works.whatsapp.name;
              })}
            </div>
            <p className="text-sm text-muted-foreground">
              {status && !status.configured
                ? t(($) => {
                    return $.works.whatsapp.unavailable;
                  })
                : t(($) => {
                    return $.works.whatsapp.description;
                  })}
            </p>
          </div>
          {status?.linked ? (
            <>
              <ConnectedIndicator connectedDetail={status.phoneHandle} />
              <ProviderCardMenu
                moreOptionsLabel={t(($) => {
                  return $.works.whatsapp.options;
                })}
                disconnectLabel={t(($) => {
                  return $.works.actions.disconnect;
                })}
                disconnecting={disconnectLoadable.state === "loading"}
                onDisconnect={() => {
                  return detach(disconnect(signal), Reason.DomCallback);
                }}
              />
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1.5 rounded-lg"
              disabled={!status?.configured}
              aria-label={t(($) => {
                return $.works.whatsapp.connect;
              })}
              onClick={() => {
                setOpen(true);
                generateCode();
              }}
            >
              {t(($) => {
                return $.connectors.actions.connect;
              })}
            </Button>
          )}
        </div>
      </div>
      <WhatsappConnectContent
        phone={phone}
        code={code}
        loading={codeLoadable.state === "loading"}
        failed={codeLoadable.state === "hasError"}
        onGenerate={generateCode}
      />
    </Dialog>
  );
}
