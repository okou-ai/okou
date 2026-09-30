import { useLastResolved, useLoadable } from "ccstate-react";
import { orgModelPolicies$ } from "../../../../../signals/external/org-model-policies.ts";
import { isOrgAdmin$ } from "../../../../../signals/org.ts";
import { OrgProvidersTab } from "../../org-manage/org-providers-tab.tsx";
import { PersonalProvidersTab } from "../../preferences/personal-providers-tab.tsx";

export function ModelSection() {
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const policies = useLastResolved(orgModelPolicies$);

  return (
    <div className="flex flex-col gap-10">
      {isAdmin && policies && policies.modelMode !== "auto" && (
        <OrgProvidersTab />
      )}
      <PersonalProvidersTab />
    </div>
  );
}
