import { Button } from "@okouai/ui";
import { useGet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ArrowRightLeft, LogIn } from "lucide-react";
import { useTranslation } from "react-i18next";
import { currentUserInfo$ } from "../../signals/auth.ts";
import { openClerkAddAccount$ } from "../../signals/clerk-add-account.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { signInToSharedArtifact$ } from "../../signals/shared-artifact-page.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ResourceAccessCard } from "./resource-access-card.tsx";

export function ArtifactAccessCard() {
  const { t } = useTranslation();
  const user = useLastResolved(currentUserInfo$);
  const pageSignal = useGet(pageSignal$);
  const [accessLoadable, openAccess] = useLoadableSet(
    user ? openClerkAddAccount$ : signInToSharedArtifact$,
  );
  return (
    <ResourceAccessCard
      title={t(($) => {
        return $.artifacts.access.title;
      })}
      description={
        user
          ? t(($) => {
              return $.artifacts.access.signedInDescription;
            })
          : t(($) => {
              return $.artifacts.access.description;
            })
      }
      help={t(($) => {
        return $.artifacts.access.help;
      })}
      email={user?.primaryEmailAddress?.emailAddress}
      error={
        accessLoadable.state === "hasError"
          ? user
            ? t(($) => {
                return $.artifacts.access.switchAccountFailed;
              })
            : t(($) => {
                return $.artifacts.access.signInFailed;
              })
          : undefined
      }
    >
      <Button
        type="button"
        variant={user ? "outline" : "default"}
        disabled={accessLoadable.state === "loading"}
        aria-busy={accessLoadable.state === "loading"}
        onClick={() => {
          detach(
            openAccess(window.location.href, pageSignal),
            Reason.DomCallback,
          );
        }}
      >
        {user ? <ArrowRightLeft aria-hidden /> : <LogIn aria-hidden />}
        {user
          ? t(($) => {
              return $.artifacts.access.switchAccount;
            })
          : t(($) => {
              return $.artifacts.access.signIn;
            })}
      </Button>
    </ResourceAccessCard>
  );
}
