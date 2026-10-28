import type { ComponentProps, ReactNode } from "react";
import { AlertCircle, ArrowLeft, CircleCheck, Loader2 } from "lucide-react";
import { surfaceVariants, Button, buttonVariants, cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { resolveAppAuthUrl } from "../../signals/auth.ts";
import { Link } from "../router/link.tsx";

export type MarkState = "idle" | "success" | "error" | "loading" | "warning";

export function connectErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Centered card layout for connector sign-in, authorization, and status pages. */
export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="box-border h-full min-h-0 w-full overflow-y-auto bg-background pb-safe relative z-0 before:absolute before:inset-0 before:-z-1 before:bg-workspace-canvas before:bg-workspace-canvas-image before:bg-[length:100%_100%] before:content-['']">
      <div className="flex min-h-full w-full flex-col items-center p-4">
        <div
          className={surfaceVariants({
            className:
              "my-auto w-full max-w-sm shrink-0 p-5 sm:p-8 flex flex-col items-center gap-6",
          })}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function CenterText({
  title,
  body,
}: {
  title: string;
  body: ReactNode;
}) {
  return (
    <div className="text-center space-y-1.5">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
    </div>
  );
}

export function ConnectBackLink({
  pathname,
  label,
}: {
  pathname: ComponentProps<typeof Link>["pathname"];
  label: string;
}) {
  return (
    <Link
      pathname={pathname}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
    >
      <ArrowLeft size={14} />
      {label}
    </Link>
  );
}

export function SettingsBackLink({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <ConnectBackLink
      pathname="/works"
      label={
        label ??
        t(($) => {
          return $.connectors.providerConnect.common.backToSettings;
        })
      }
    />
  );
}

export function ConnectActionGroup({
  primary,
  secondary,
}: {
  primary: ReactNode;
  secondary: ReactNode;
}) {
  return (
    <div className="flex w-full flex-col gap-3">
      {primary}
      <div className="flex justify-center">{secondary}</div>
    </div>
  );
}

export function ConnectSuccessState({
  title,
  description,
  openHref,
  openLabel,
  openIcon,
  notice,
}: {
  title: string;
  description: ReactNode;
  openHref: string | null;
  openLabel: string;
  openIcon: ReactNode;
  notice?: ReactNode;
}) {
  return (
    <>
      <CircleCheck size={40} className="text-emerald-500" />
      <CenterText title={title} body={description} />
      {notice}
      <ConnectActionGroup
        primary={
          openHref ? (
            <a href={openHref} className={cn(buttonVariants(), "w-full gap-2")}>
              {openIcon}
              {openLabel}
            </a>
          ) : null
        }
        secondary={<SettingsBackLink />}
      />
    </>
  );
}

export function ConnectStatusMark({
  state = "idle",
  idle,
}: {
  state?: MarkState;
  idle: ReactNode;
}) {
  if (state === "success") {
    return <CircleCheck size={40} className="text-emerald-500" />;
  }

  if (state === "warning") {
    return <AlertCircle size={40} className="text-amber-500" />;
  }

  if (state === "error") {
    return <AlertCircle size={40} className="text-destructive" />;
  }

  if (state === "loading") {
    return <Loader2 size={40} className="animate-spin" />;
  }

  return idle;
}

export function ConnectErrorAlert({ error }: { error: string | null }) {
  if (!error) {
    return null;
  }

  return (
    <div
      className="w-full rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
      role="alert"
    >
      {error}
    </div>
  );
}

export function ConnectSubmitButton({
  connecting,
  onConnect,
  label,
  spinnerClassName = "animate-spin",
}: {
  connecting: boolean;
  onConnect: () => void;
  label?: string;
  spinnerClassName?: string;
}) {
  const { t } = useTranslation();
  return (
    <Button className="w-full" disabled={connecting} onClick={onConnect}>
      {connecting ? <Loader2 size={16} className={spinnerClassName} /> : null}
      {connecting
        ? t(($) => {
            return $.connectors.actions.connecting;
          })
        : (label ??
          t(($) => {
            return $.connectors.actions.connect;
          }))}
    </Button>
  );
}

export function ConnectSignInState({
  mark,
  title,
  description,
  button,
}: {
  mark: ReactNode;
  title: string;
  description: string;
  button: string;
}) {
  return (
    <PageShell>
      {mark}
      <CenterText title={title} body={description} />
      <a
        href={resolveAppAuthUrl("/sign-in", { redirectUrl: location.href })}
        className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
      >
        {button}
      </a>
    </PageShell>
  );
}

export function ConnectErrorState({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <>
      <AlertCircle size={40} className="text-destructive" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.common.connectionFailed;
        })}
        body={message}
      />
      <SettingsBackLink />
    </>
  );
}

export function ConnectCheckingState() {
  const { t } = useTranslation();
  return (
    <>
      <Loader2 size={40} className="animate-spin" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.common.checkingTitle;
        })}
        body={t(($) => {
          return $.connectors.providerConnect.common.verifying;
        })}
      />
    </>
  );
}

export function ConnectInvalidLinkState({
  description,
}: {
  description: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <AlertCircle size={40} className="" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.common.invalidLink;
        })}
        body={description}
      />
      <SettingsBackLink />
    </>
  );
}
