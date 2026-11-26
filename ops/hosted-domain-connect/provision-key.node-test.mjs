import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const entry = new URL("./provision-key.node.mjs", import.meta.url).pathname;
const provider = `
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const privateName = 'HOSTED_SITE_DOMAIN_CONNECT_PRIVATE_KEY_BASE64';
const hostName = 'HOSTED_SITE_DOMAIN_CONNECT_KEY_HOST';
const stored = {};
let writes = 0, expectedPublicKey;
if (process.env.KEY_TEST_MODE === 'existing') {
  stored[privateName] = { raw: generateKeyPairSync('rsa', {modulusLength:2048}).privateKey.export({format:'der',type:'pkcs8'}).toString('base64') };
  stored[privateName].computed = stored[privateName].raw;
  stored[hostName] = {raw:'sites-v1',computed:'sites-v1'};
}
if (process.env.KEY_TEST_MODE === 'partial') stored[hostName] = {raw:'different-key',computed:'different-key'};
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  const payload = init.body ? JSON.parse(init.body) : undefined;
  if (url.hostname === 'test.actions.githubusercontent.com') return Response.json({value:'test-oidc'});
  if (url.pathname === '/v3/auth/oidc') {
    assert.deepEqual(payload,{identity:'test-identity',token:'test-oidc'});
    return Response.json({token:'test-doppler-token'});
  }
  assert.equal(url.origin,'https://api.doppler.com');
  assert.equal(init.headers.Authorization,'Bearer test-doppler-token');
  if (init.method === 'GET') {
    assert.equal(url.pathname,'/v3/configs/config/secret');
    assert.equal(url.searchParams.get('project'),'vm0');
    assert.equal(url.searchParams.get('config'),'prd');
    const name = url.searchParams.get('name');
    assert.ok([privateName,hostName].includes(name));
    return Response.json({value:stored[name]??null,success:true});
  }
  assert.equal(url.pathname,'/v3/configs/config/secrets');
  assert.equal(payload.project,'vm0'); assert.equal(payload.config,'prd');
  assert.deepEqual(payload.change_requests.map(c=>c.name),[privateName,hostName]);
  writes++;
  for (const change of payload.change_requests) {
    assert.equal(change.visibility,'masked');
    assert.equal(change.originalValue,null);
    stored[change.name] = {raw:change.value,computed:change.value};
  }
  if (process.env.KEY_TEST_MODE === 'uncertain') return new Response(null,{status:503});
  return Response.json({success:true});
};
process.on('exit',()=>{
  if (stored[privateName]) expectedPublicKey = createPublicKey(createPrivateKey({key:Buffer.from(stored[privateName].computed,'base64'),type:'pkcs8',format:'der'})).export({type:'spki',format:'der'}).toString('base64');
  writeFileSync(process.env.KEY_TEST_TRACE,JSON.stringify({writes,expectedPublicKey}));
});
`;

function fixture(t, mode) {
  const directory = mkdtempSync(join(tmpdir(), "domain-connect-key-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const preload = join(directory, "provider.mjs");
  const trace = join(directory, "trace.json");
  writeFileSync(preload, provider);
  return {
    directory,
    trace,
    args: ["--import", preload, entry],
    env: {
      ...process.env,
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY_ID: "1096175506",
      ACTIONS_ID_TOKEN_REQUEST_URL:
        "https://test.actions.githubusercontent.com/oidc",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-actions-token",
      DOPPLER_SERVICE_IDENTITY_ID: "test-identity",
      RUNNER_TEMP: directory,
      KEY_TEST_TRACE: trace,
      KEY_TEST_MODE: mode,
    },
  };
}

for (const mode of ["new", "existing"]) {
  test(`${mode} key publishes only the matching public DNS fragments`, (t) => {
    const setup = fixture(t, mode);
    const stdout = execFileSync(process.execPath, setup.args, {
      env: setup.env,
      encoding: "utf8",
    });
    const trace = JSON.parse(readFileSync(setup.trace, "utf8"));
    assert.equal(trace.writes, mode === "new" ? 1 : 0);
    const result = JSON.parse(
      readFileSync(
        join(setup.directory, "hosted-domain-connect-public-key.json"),
        "utf8",
      ),
    );
    const fragments = result.records.map((record, index) => {
      assert.equal(record.type, "TXT");
      assert.equal(record.name, "sites-v1.domainconnect.okou.ai");
      assert.ok(record.content.length <= 255);
      assert.ok(record.content.startsWith(`p=${index + 1},d=`));
      return record.content.split(",d=")[1].split(",a=")[0];
    });
    assert.equal(fragments.join(""), trace.expectedPublicKey);
    assert.equal(
      stdout,
      "Production signing key stored in Doppler; public DNS records retained.\n",
    );
  });
}

test("a branch cannot enter provisioning", () => {
  const result = spawnSync(process.execPath, [entry], {
    env: { ...process.env, GITHUB_REF: "refs/heads/fix/unreviewed" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires trusted main/u);
  assert.equal(result.stdout, "");
});

for (const mode of ["partial", "uncertain"]) {
  test(`${mode} configuration stops without replacing or retrying a key`, (t) => {
    const setup = fixture(t, mode);
    const result = spawnSync(process.execPath, setup.args, {
      env: setup.env,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      JSON.parse(readFileSync(setup.trace, "utf8")).writes,
      mode === "uncertain" ? 1 : 0,
    );
    assert.throws(() =>
      readFileSync(
        join(setup.directory, "hosted-domain-connect-public-key.json"),
      ),
    );
  });
}
