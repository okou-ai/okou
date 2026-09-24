import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { ComputerUseDriverController } from "../computer-use-driver";
import {
  createComputerUseNativeBackend,
  type ComputerUseNativeRuntimeErrorContext,
} from "../computer-use-native";
import { ComputerUseRuntimeController } from "../computer-use-runtime-controller";
import { createDesktopComputerUsePermissions } from "../desktop-computer-use-permissions";
import { createDesktopComputerUseHostRuntime } from "../desktop-computer-use-api";
import { DesktopAuthSession } from "../desktop-auth-session";

/** Executed in an isolated Node process; Vitest's event loop never stalls. */
export async function runPermissionStallFixture(
  directory: string,
): Promise<void> {
  const helper = path.join(directory, "helper.sh");
  const received = path.join(directory, "received");
  const written = path.join(directory, "written");
  const release = path.join(directory, "release");
  const armed = path.join(directory, "armed");
  const starts = path.join(directory, "starts");
  writeFileSync(starts, "");
  execFileSync("mkfifo", [release]);
  writeFileSync(
    helper,
    `#!/bin/sh
printf '%s\\n' "$$" >> ${JSON.stringify(starts)}
while IFS= read -r line; do
  id=\${line#*\\"id\\":\\"}
  id=\${id%%\\"*}
  if [ -f ${JSON.stringify(armed)} ] && [ ! -f ${JSON.stringify(received)} ]; then
    : > ${JSON.stringify(received)}
    IFS= read -r _ < ${JSON.stringify(release)}
    printf '{"id":"%s","status":"succeeded","result":{"accessibility":true,"screenRecording":true}}\\n' "$id"
    : > ${JSON.stringify(written)}
  else
    printf '{"id":"%s","status":"succeeded","result":{"accessibility":true,"screenRecording":true}}\\n' "$id"
  fi
done
`,
  );
  chmodSync(helper, 0o755);
  const api = "https://native-permission-fixture.test";
  const server = setupServer(
    http.all(`${api}/*`, ({ request }) => {
      const route = new URL(request.url).pathname;
      if (route === "/api/auth/me")
        return HttpResponse.json({
          userId: "fixture",
          email: "fixture@example.test",
          orgId: "fixture-org",
          sessionId: "fixture-session",
        });
      if (route === "/api/org")
        return HttpResponse.json({ id: "fixture-org", name: "Fixture" });
      if (route.endsWith("/hosts/start"))
        return HttpResponse.json({
          hostId: "fixture-host",
          hostToken: "fixture-token",
        });
      return HttpResponse.json({ status: "idle" });
    }),
  );
  server.listen({ onUnhandledRequest: "error" });
  const auth = new DesktopAuthSession({
    apiBaseUrl: api,
    addClientHeaders: () => {},
    tokenUrl: `${api}/token`,
    selectOrgUrl: `${api}/org`,
    consumeUrl: () => `${api}/consume`,
    runAuthWindow: async () => "fixture-token",
  });
  const errors: ComputerUseNativeRuntimeErrorContext[] = [];
  const driver = new ComputerUseDriverController(
    {
      id: "okou",
      createBackend: () =>
        createComputerUseNativeBackend({
          helperPath: helper,
          requestTimeoutMs: 400,
          onRuntimeError: (_error, context) => errors.push(context),
        }),
    },
    "darwin",
  );
  const permissions = createDesktopComputerUsePermissions({
    driver,
    refreshNative: (query) => controller.refreshNativePermissions(query),
  });
  const controller = new ComputerUseRuntimeController({
    driver,
    refreshPermissions: permissions.refreshComputerUsePermissionState,
    transitionTimeoutMs: 4_000,
    getAuthState: () => auth.getAuthState(),
    setHostRuntimeOnline: () => {},
    createRuntime: () =>
      createDesktopComputerUseHostRuntime(
        {
          platformUrl: new URL(api),
          installationId: "00000000-0000-4000-8000-000000000001",
          hostName: "fixture",
          appVersion: "test",
          addClientHeaders: () => {},
          hostFetch: (input, init) => fetch(input, init),
          getPermissions: permissions.refreshReady,
          getSupportedCapabilities: () => driver.getCapabilities(),
          driver,
          executePluginCommand: async () => {
            throw new Error("No plugin in this fixture");
          },
        },
        { getAuthSession: () => auth },
      ),
  });
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    await controller.start();
    // The 400 ms deadline belongs to the later blocked-parent request. Under
    // a parallel test run, a cold helper can miss it before the fixture is
    // armed. Recover setup attempts without changing the tested deadline.
    for (
      let attempt = 0;
      attempt < 6 &&
      (!driver.getState().ready || !controller.isRuntimeOnline());
      attempt++
    ) {
      await controller.start({ userInitiated: true });
    }
    if (!driver.getState().ready || !controller.isRuntimeOnline()) {
      throw new Error(
        `Permission stall fixture did not reach a ready host: ${JSON.stringify({
          driver: driver.getState(),
          host: controller.getHostState(),
          errors,
        })}`,
      );
    }
    const generation = driver.generation;
    const startsBeforeStall = readFileSync(starts, "utf8")
      .trim()
      .split("\n").length;
    errors.length = 0;
    const receipt = new Promise<void>((resolve) => {
      watcher = watch(directory, () => {
        if (existsSync(received)) {
          watcher?.close();
          resolve();
        }
      });
    });
    writeFileSync(armed, "armed");
    const startedAt = Date.now();
    const query = permissions.refreshComputerUsePermissionState();
    // Observe rejection immediately so the old-source red run is also clean.
    const result = query.then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, message: String(error) }),
    );
    await receipt;
    // The independent coordinator releases the warmed helper while this parent
    // is synchronously blocked. It exits only after that helper proves write(2)
    // completed AND the first attempt deadline has elapsed. No polling sleeps.
    const blocked = spawnSync(
      process.execPath,
      [
        "-e",
        `
const fs = require('node:fs');
let deadlinePassed = false;
const finish = () => { if (deadlinePassed && fs.existsSync(${JSON.stringify(written)})) { watcher.close(); process.exit(0); } };
const watcher = fs.watch(${JSON.stringify(directory)}, finish);
setTimeout(() => {deadlinePassed=true;finish();}, Math.max(0, ${startedAt + 850} - Date.now()));
const releaseFd = fs.openSync(${JSON.stringify(release)}, 'w');
fs.writeSync(releaseFd, 'release\\n');
fs.closeSync(releaseFd);
`,
      ],
      { timeout: 5_000, encoding: "utf8" },
    );
    if (blocked.status !== 0)
      throw new Error(`Stall coordinator failed: ${blocked.status}`);
    const outcome = await result;
    process.stdout.write(
      JSON.stringify({
        outcome,
        generation,
        freshGeneration: driver.generation,
        ready: driver.getCapabilities().length > 0,
        writtenAfterMs: statSync(written).mtimeMs - startedAt,
        elapsedMs: Date.now() - startedAt,
        startsAfterStall:
          readFileSync(starts, "utf8").trim().split("\n").length -
          startsBeforeStall,
        errors,
      }) + "\n",
    );
  } finally {
    watcher?.close();
    await controller.stopForQuit();
    server.close();
  }
}
