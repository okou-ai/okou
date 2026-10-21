import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import {
  Button,
  Checkbox,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  surfaceVariants,
} from "@okouai/ui";

export function RemoteCredentialReplacement({
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2 border-t border-divider pt-4">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
        />
        {t(($) => {
          return $.remoteCredentials.changeLogin;
        })}
      </label>
      {!checked && (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteCredentials.keepLogin;
          })}
        </p>
      )}
    </div>
  );
}

function CredentialDeleteInfo() {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger
        render={
          <IconButton
            type="button"
            className="size-7 text-muted-foreground"
            aria-label={t(($) => {
              return $.remoteCredentials.deleteInfo;
            })}
          />
        }
      >
        <Info size={16} aria-hidden />
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] text-sm leading-6">
        {t(($) => {
          return $.remoteCredentials.inUseHelp;
        })}
      </PopoverContent>
    </Popover>
  );
}

export function RemoteCredentialCard({
  name,
  username,
  method,
  hosts,
  onEdit,
  onDelete,
}: {
  readonly name: string;
  readonly username?: string;
  readonly method: ReactNode;
  readonly hosts: readonly {
    readonly id: string;
    readonly displayName: string;
  }[];
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <article className={surfaceVariants({ className: "grid gap-5 p-5" })}>
      <header className="grid gap-3">
        <h2 className="break-words font-semibold">{name}</h2>
        <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          {username && (
            <>
              <dt className="text-muted-foreground">
                {t(($) => {
                  return $.remoteCredentials.username;
                })}
              </dt>
              <dd className="break-all">{username}</dd>
            </>
          )}
          <dt className="text-muted-foreground">
            {t(($) => {
              return $.remoteCredentials.loginMethod;
            })}
          </dt>
          <dd className="break-words">{method}</dd>
        </dl>
      </header>
      {hosts.length > 0 ? (
        <section className="grid gap-2 text-sm">
          <h3 className="text-muted-foreground">
            {t(($) => {
              return $.remoteCredentials.usedBy;
            })}
          </h3>
          <ul className="grid list-disc gap-1 pl-5 leading-6 marker:text-muted-foreground">
            {hosts.map((host) => {
              return (
                <li key={host.id} className="break-words">
                  {host.displayName}
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteCredentials.unused;
          })}
        </p>
      )}
      <footer className="flex flex-wrap items-center gap-2 border-t border-divider pt-4">
        <Button type="button" variant="outline" onClick={onEdit}>
          {t(($) => {
            return $.remoteCredentials.edit;
          })}
        </Button>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            disabled={hosts.length > 0}
            onClick={onDelete}
          >
            {t(($) => {
              return $.remoteCredentials.delete;
            })}
          </Button>
          {hosts.length > 0 && <CredentialDeleteInfo />}
        </div>
      </footer>
    </article>
  );
}
