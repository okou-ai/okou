import { useLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { Button } from "@okouai/ui/components/ui/button";
import { clerk$, currentUserInfo$ } from "../../../../../signals/auth.ts";
import { UserAvatar } from "../../../../components/avatar.tsx";

export function AccountSection() {
  const { t } = useTranslation();
  const clerkLoadable = useLoadable(clerk$);
  const clerk =
    clerkLoadable.state === "hasData" ? clerkLoadable.data : undefined;
  const userLoadable = useLoadable(currentUserInfo$);
  const user = userLoadable.state === "hasData" ? userLoadable.data : undefined;
  const userProfileUrl = clerk?.buildUrlWithAuth(clerk.buildUserProfileUrl());

  const displayName = user?.fullName ?? user?.firstName ?? "";
  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  const initial = (displayName || email || "U").charAt(0).toUpperCase();

  return (
    <div className="flex items-center gap-4 bg-card rounded-xl border border-surface-border p-5">
      <UserAvatar
        imageUrl={user?.imageUrl}
        name={displayName}
        initial={initial}
        size="xl"
      />
      <div className="flex-1 min-w-0">
        {displayName && (
          <div className="text-sm font-medium text-foreground truncate">
            {displayName}
          </div>
        )}
        {email && (
          <div className="text-sm text-muted-foreground truncate">{email}</div>
        )}
      </div>
      {userProfileUrl && (
        <Button asChild className="shrink-0">
          <a href={userProfileUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            {t(($) => {
              return $.settings.preferences.account.manage;
            })}
          </a>
        </Button>
      )}
    </div>
  );
}
