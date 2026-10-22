import { authenticatedSessionKey$ } from "../../signals/auth.ts";
import { remoteNetworkInitialization$ } from "../../signals/remote-network-page-setup.ts";
import {
  useLastLoadable,
  useLastResolved,
  useGet,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { Button, Card, LoadErrorRow } from "@okouai/ui";
import {
  remoteResource$,
  closeRemoteResource$,
  remoteNetworkPage$,
  closeRemoteNetworkPage$,
  saveRemoteTailscale$,
  saveRemoteCloudflare$,
} from "../../signals/remote-resource-detail.ts";
import {
  sshConnections$,
  sshDialog$,
  closeSshDialog$,
  invalidateSsh$,
} from "../../signals/ssh.ts";
import {
  vncConnections$,
  vncDialog$,
  closeVncDialog$,
  invalidateVnc$,
} from "../../signals/vnc.ts";
import {
  tailscaleConfigs$,
  invalidateTailscale$,
} from "../../signals/tailscale.ts";
import {
  cloudflareAccessConfigs$,
  invalidateCloudflareAccess$,
} from "../../signals/cloudflare-access.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { RemoteDetailPage } from "./remote-detail-page.tsx";
import { SshHostCard, SshDialog } from "./ssh-management.tsx";
import { VncHostCard } from "./vnc-management.tsx";
import { VncDialog } from "./vnc-dialog.tsx";
import { TailscaleSection, TailscaleDialog } from "./tailscale-management.tsx";
import {
  CloudflareAccessSection,
  CloudflareAccessDialog,
  CloudflareAccessConversionDialog,
  CloudflareAccessDeletionDialog,
  CloudflareAccessPromotionDialog,
} from "./cloudflare-access.tsx";
import { NetworkProviderPicker } from "./remote-network-picker.tsx";
import {
  mountPrivateNetworkPanel$,
  mountRemoteControlPanel$,
} from "../../signals/remote-management-realtime.ts";

function useRemoteResourceRecords() {
  const resource = useGet(remoteResource$);
  const ssh = useLastLoadable(sshConnections$);
  const vnc = useLastLoadable(vncConnections$);
  const tailscale = useLastLoadable(tailscaleConfigs$);
  const access = useLastLoadable(cloudflareAccessConfigs$);
  const sshHost =
    ssh.state === "hasData"
      ? ssh.data?.find((host) => {
          return resource?.kind === "ssh" && host.id === resource?.id;
        })
      : null;
  const vncHost =
    vnc.state === "hasData"
      ? vnc.data?.find((host) => {
          return resource?.kind === "vnc" && host.id === resource?.id;
        })
      : null;
  const ts =
    tailscale.state === "hasData"
      ? tailscale.data?.find((config) => {
          return resource?.kind === "tailscale" && config.id === resource?.id;
        })
      : null;
  const cf =
    access.state === "hasData"
      ? access.data?.find((config) => {
          return resource?.kind === "cloudflare" && config.id === resource?.id;
        })
      : null;
  return { sshHost, vncHost, ts, cf };
}

function useRemoteResourceEditing() {
  const sessionKey = useGet(authenticatedSessionKey$);
  const sshDialog = useLastResolved(sshDialog$);
  const vncDialog = useLastResolved(vncDialog$);
  const sshEdit =
    sshDialog?.sessionKey === sessionKey && sshDialog?.kind === "edit";
  const vncEdit =
    vncDialog?.sessionKey === sessionKey && vncDialog?.kind === "edit";
  return { sshEdit, vncEdit };
}

function useRemoteResourceState() {
  const resource = useGet(remoteResource$);
  const ssh = useLastLoadable(sshConnections$);
  const vnc = useLastLoadable(vncConnections$);
  const tailscale = useLastLoadable(tailscaleConfigs$);
  const access = useLastLoadable(cloudflareAccessConfigs$);
  const admin = useLoadable(isOrgAdmin$);
  const { sshEdit, vncEdit } = useRemoteResourceEditing();
  const data =
    resource?.kind === "ssh"
      ? ssh
      : resource?.kind === "vnc"
        ? vnc
        : resource?.kind === "tailscale"
          ? tailscale
          : access;
  return { resource, sshEdit, vncEdit, data, admin };
}

function RemoteResourceLoadError() {
  const { t } = useTranslation();
  const resource = useGet(remoteResource$);
  const retry = useSet(
    resource?.kind === "ssh"
      ? invalidateSsh$
      : resource?.kind === "vnc"
        ? invalidateVnc$
        : resource?.kind === "tailscale"
          ? invalidateTailscale$
          : invalidateCloudflareAccess$,
  );
  return (
    <LoadErrorRow
      message={t(($) => {
        return resource?.kind === "ssh"
          ? $.ssh.loadFailed
          : resource?.kind === "vnc"
            ? $.vnc.loadFailed
            : resource?.kind === "tailscale"
              ? $.tailscale.loadFailed
              : $.cloudflareAccess.loadFailed;
      })}
      retryLabel={t(($) => {
        return $.remoteControlSetup.retry;
      })}
      onRetry={retry}
    />
  );
}

function RemoteResourceDetails() {
  const records = useRemoteResourceRecords();
  const { t } = useTranslation();
  const { resource, sshEdit, vncEdit, data, admin } = useRemoteResourceState();
  if (!resource) {
    return null;
  }
  if (data.state !== "hasData" && !sshEdit && !vncEdit) {
    if (data.state === "hasError") {
      return <RemoteResourceLoadError />;
    }
    return (
      <p role="status">
        {t(($) => {
          return $.remoteControlSetup.loading;
        })}
      </p>
    );
  }
  const { sshHost, vncHost, ts, cf } = records;
  const canManageOrg = admin.state === "hasData" && admin.data;
  return (
    <>
      {sshHost && !sshEdit && (
        <Card surface="composer" className="grid gap-5 p-5 sm:p-6">
          <SshHostCard connection={sshHost} detail />
        </Card>
      )}
      {vncHost && !vncEdit && (
        <Card surface="composer" className="grid gap-5 p-5 sm:p-6">
          <VncHostCard connection={vncHost} detail />
        </Card>
      )}
      {ts && (
        <Card surface="composer" className="p-5 sm:p-6">
          <TailscaleSection
            compact
            scope={ts.scope}
            configs={[ts]}
            admin={canManageOrg}
          />
        </Card>
      )}
      {cf && (
        <Card surface="composer" className="p-5 sm:p-6">
          <CloudflareAccessSection
            compact
            scope={cf.scope}
            configs={[cf]}
            canManage={cf.scope === "personal" || canManageOrg}
            canPromote={canManageOrg}
          />
        </Card>
      )}
      {!sshHost && !vncHost && !ts && !cf && !sshEdit && !vncEdit && (
        <p role="status">
          {t(($) => {
            return $.remoteControlSetup.resourceUnavailable;
          })}
        </p>
      )}
    </>
  );
}

function RemoteResourceContent() {
  const { sshEdit, vncEdit } = useRemoteResourceEditing();
  return (
    <>
      <RemoteResourceDetails />
      <SshDialog inline={sshEdit} />
      <VncDialog inline={vncEdit} />
      <TailscaleDialog />
      <CloudflareAccessDialog />
      <CloudflareAccessConversionDialog />
      <CloudflareAccessDeletionDialog />
      <CloudflareAccessPromotionDialog />
    </>
  );
}
export function RemoteResourcePage() {
  const { t } = useTranslation();
  const resource = useGet(remoteResource$);
  const close = useSet(closeRemoteResource$);
  const { sshEdit, vncEdit } = useRemoteResourceEditing();
  const sessionKey = useGet(authenticatedSessionKey$);
  const closeSsh = useSet(closeSshDialog$);
  const closeVnc = useSet(closeVncDialog$);
  const editingSsh = resource?.kind === "ssh" && sshEdit;
  const editingVnc = resource?.kind === "vnc" && vncEdit;
  const editing = editingSsh || editingVnc;
  const network =
    resource?.kind === "tailscale" || resource?.kind === "cloudflare";
  const mount = useSet(
    network ? mountPrivateNetworkPanel$ : mountRemoteControlPanel$,
  );
  return (
    <RemoteDetailPage
      network={network}
      title={t(($) => {
        return network
          ? $.remoteControlSetup.networkSettings
          : editing
            ? $.remoteControlSetup.editConnection
            : $.remoteControlSetup.connectionDetails;
      })}
      onBack={close}
    >
      <div ref={mount} className="mx-auto grid max-w-[760px] gap-6">
        <Button
          variant="quiet"
          className="justify-self-start"
          onClick={editingSsh ? closeSsh : editingVnc ? closeVnc : close}
        >
          <ArrowLeft size={16} aria-hidden />
          {t(($) => {
            return network
              ? $.remoteControlSetup.backToNetworks
              : editing
                ? $.remoteControlSetup.backToDetails
                : $.remoteControlSetup.backToConnections;
          })}
        </Button>
        {sessionKey && (
          <RemoteResourceContent
            key={`${sessionKey}:${resource?.kind}:${resource?.id}`}
          />
        )}
      </div>
    </RemoteDetailPage>
  );
}
export function RemoteNetworkPage() {
  const { t } = useTranslation();
  const page = useGet(remoteNetworkPage$);
  const initialization = useLoadable(remoteNetworkInitialization$);
  const close = useSet(closeRemoteNetworkPage$);
  return (
    <RemoteDetailPage
      network
      title={t(($) => {
        return $.remoteControlSetup.networkSettings;
      })}
      onBack={close}
    >
      <div className="mx-auto grid max-w-[760px] gap-6">
        <Button variant="quiet" className="justify-self-start" onClick={close}>
          <ArrowLeft size={16} aria-hidden />
          {t(($) => {
            return $.remoteControlSetup.back;
          })}
        </Button>
        {initialization.state !== "hasData" ? (
          <p role={initialization.state === "hasError" ? "alert" : "status"}>
            {t(($) => {
              return initialization.state === "hasError"
                ? $.remoteControlSetup.failedLoad
                : $.remoteControlSetup.loading;
            })}
          </p>
        ) : page === "provider" ? (
          <NetworkProviderPicker inline />
        ) : page === "tailscale" ? (
          <div>
            <TailscaleDialog inline saveAction={saveRemoteTailscale$} />
          </div>
        ) : (
          <div>
            <CloudflareAccessDialog inline saveAction={saveRemoteCloudflare$} />
          </div>
        )}
      </div>
    </RemoteDetailPage>
  );
}
