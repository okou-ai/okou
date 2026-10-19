import { authenticatedSessionKey$ } from "../../signals/auth.ts";
import { useLastResolved, useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { Button, Card } from "@okouai/ui";
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
} from "../../signals/ssh.ts";
import {
  vncConnections$,
  vncDialog$,
  closeVncDialog$,
} from "../../signals/vnc.ts";
import { tailscaleConfigs$ } from "../../signals/tailscale.ts";
import { cloudflareAccessConfigs$ } from "../../signals/cloudflare-access.ts";
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

function useRemoteResourceRecords() {
  const resource = useGet(remoteResource$);
  const ssh = useLoadable(sshConnections$);
  const vnc = useLoadable(vncConnections$);
  const tailscale = useLoadable(tailscaleConfigs$);
  const access = useLoadable(cloudflareAccessConfigs$);
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

function useRemoteResourceState() {
  const resource = useGet(remoteResource$);
  const ssh = useLoadable(sshConnections$);
  const vnc = useLoadable(vncConnections$);
  const tailscale = useLoadable(tailscaleConfigs$);
  const access = useLoadable(cloudflareAccessConfigs$);
  const admin = useLoadable(isOrgAdmin$);
  const sessionKey = useGet(authenticatedSessionKey$);
  const sshDialog = useLastResolved(sshDialog$);
  const vncDialog = useLastResolved(vncDialog$);
  const sshEdit =
    sshDialog?.sessionKey === sessionKey && sshDialog?.kind === "edit";
  const vncEdit =
    vncDialog?.sessionKey === sessionKey && vncDialog?.kind === "edit";
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

function RemoteResourceContent() {
  const records = useRemoteResourceRecords();
  const { t } = useTranslation();
  const { resource, sshEdit, vncEdit, data, admin } = useRemoteResourceState();
  if (!resource) {
    return null;
  }
  if (data.state !== "hasData" && !sshEdit && !vncEdit) {
    return (
      <p role={data.state === "hasError" ? "alert" : "status"}>
        {t(($) => {
          return data.state === "hasError"
            ? $.remoteControlSetup.failedLoad
            : $.remoteControlSetup.loading;
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
  const sshDialog = useLastResolved(sshDialog$);
  const vncDialog = useLastResolved(vncDialog$);
  const sessionKey = useGet(authenticatedSessionKey$);
  const closeSsh = useSet(closeSshDialog$);
  const closeVnc = useSet(closeVncDialog$);
  const editingSsh =
    resource?.kind === "ssh" &&
    sshDialog?.sessionKey === sessionKey &&
    sshDialog?.kind === "edit";
  const editingVnc =
    resource?.kind === "vnc" &&
    vncDialog?.sessionKey === sessionKey &&
    vncDialog?.kind === "edit";
  const editing = editingSsh || editingVnc;
  const network =
    resource?.kind === "tailscale" || resource?.kind === "cloudflare";
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
      <div className="mx-auto grid max-w-[760px] gap-6">
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
        <RemoteResourceContent />
      </div>
    </RemoteDetailPage>
  );
}
export function RemoteNetworkPage() {
  const { t } = useTranslation();
  const page = useLoadable(remoteNetworkPage$);
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
        {page.state === "hasData" && page.data === "provider" && (
          <NetworkProviderPicker inline />
        )}
        <div hidden={page.state !== "hasData" || page.data !== "tailscale"}>
          <TailscaleDialog inline saveAction={saveRemoteTailscale$} />
        </div>
        <div hidden={page.state !== "hasData" || page.data !== "cloudflare"}>
          <CloudflareAccessDialog inline saveAction={saveRemoteCloudflare$} />
        </div>
      </div>
    </RemoteDetailPage>
  );
}
