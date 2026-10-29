import type { CdpClient } from "./client.ts";
import { CdpFault, isRecord } from "./errors.ts";
import { releaseRuntimeObjects } from "./runtime-objects.ts";
import type { TargetDirectory } from "./targets.ts";

/** One explicit create, with cleanup bound to the original transport/session. */
export async function openTab(
  client: CdpClient,
  directory: TargetDirectory,
  source: { targetId: string; sessionId: string } | null,
  current: () => boolean,
): Promise<string> {
  const check = () => {
    if (!current()) {
      throw new CdpFault("tab", "The tab action is no longer current.");
    }
  };
  check();
  let targetId: string;
  if (!source) {
    const created = await client.request("Target.createTarget", {
      url: "about:blank",
    });
    check();
    targetId = created.targetId;
  } else {
    targetId = await openSourceTab(client, directory, source, check);
  }
  if (typeof targetId !== "string" || !targetId) {
    throw new CdpFault("tab", "The browser returned an invalid new tab.");
  }
  await directory.assertMember(targetId);
  check();
  if (!source) {
    return targetId;
  }
  const detach = (value: unknown) => {
    if (isRecord(value) && typeof value.sessionId === "string") {
      client.notify("Target.detachFromTarget", { sessionId: value.sessionId });
    }
  };
  const attached = await client.request(
    "Target.attachToTarget",
    { targetId, flatten: true },
    undefined,
    detach,
  );
  if (
    !isRecord(attached) ||
    typeof attached.sessionId !== "string" ||
    !attached.sessionId
  ) {
    throw new CdpFault(
      "tab",
      "The browser returned an invalid new-tab session.",
    );
  }
  const [completion1] = await Promise.allSettled([
    (async (): Promise<string> => {
      check();
      await directory.assertMember(targetId);
      check();
      const navigation = await client.request(
        "Page.navigate",
        { url: "about:blank" },
        attached.sessionId,
      );
      check();
      if (navigation.errorText) {
        throw new CdpFault(
          "tab",
          "The new tab could not be prepared. Check the browser before trying again.",
        );
      }
      return targetId;
    })(),
  ]);

  detach(attached);

  if (completion1.status === "rejected") {
    throw completion1.reason;
  }
  return completion1.value;
}

async function openSourceTab(
  client: CdpClient,
  directory: TargetDirectory,
  source: { targetId: string; sessionId: string },
  check: () => void,
): Promise<string> {
  await directory.assertMember(source.targetId);
  check();
  const tree = await client.request(
    "Page.getFrameTree",
    undefined,
    source.sessionId,
  );
  check();
  const world = await client.request(
    "Page.createIsolatedWorld",
    {
      frameId: tree.frameTree.frame.id,
      worldName: "okou-browser-tabs",
    },
    source.sessionId,
  );
  check();
  await directory.assertMember(source.targetId);
  check();
  // getRandomValues also works in HTTP hosts where randomUUID is unavailable.
  const token = Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (byte) => {
      return byte.toString(16).padStart(2, "0");
    },
  ).join("");
  const marker = `about:blank#cdpv-${token}`;
  const release = (value: unknown) => {
    return releaseRuntimeObjects(client, source.sessionId, value);
  };
  const result = await client.request(
    "Runtime.callFunctionOn",
    {
      functionDeclaration: `function (url) {
        const tab = window.open(url, "_blank");
        if (tab) tab.opener = null;
        return !!tab;
      }`,
      arguments: [{ value: marker }],
      executionContextId: world.executionContextId,
      userGesture: true,
      returnByValue: true,
    },
    source.sessionId,
    release,
  );
  release(result);
  check();
  if (result.exceptionDetails || result.result.value !== true) {
    throw new CdpFault(
      "tab",
      "The browser blocked the new tab. Check the page's popup or sandbox policy.",
    );
  }
  const targets = await client.request("Target.getTargets", undefined);
  check();
  const matches = targets.targetInfos.filter((target) => {
    return target.type === "page" && target.url === marker;
  });
  if (matches.length !== 1 || !matches[0]) {
    throw new CdpFault(
      "tab",
      "The new tab could not be identified. Check the browser before trying again.",
    );
  }
  const targetId = matches[0].targetId;
  return targetId;
}
