# Antigravity personal subscription worker

The internal sign-in worker associates a member's Okou account with an official Google login. The native profile stays on the worker. Its terminal supports enrollment, a three-model acceptance check and logout. It accepts no workspace, model prompt or arbitrary command.

## Browser sign-in with a private native file

An operator can host multiple pilot members on one machine. Give each member a dedicated trusted OS account and isolated network and mount namespaces, or an isolated private VM. Use a fresh private home for each instance. Mount the member's encrypted writable native profile directory at `$OKOU_ANTIGRAVITY_FILE_HOME/.gemini/antigravity-cli` so the official CLI can replace its own login file during refresh. Mount the member's private Okou control directory separately at `$OKOU_ANTIGRAVITY_BINDING_DIR` to keep the binding UUID and lock. Both mounts start empty for a new member. Keep both outside job Guests. Never share a desktop, session bus, temporary directory or home with another member. Disable snapshots/backups that would retain the login after removal.

1. Install the pinned official `agy`, the Python worker and its individual rotating machine identity as described below. Install a verified build of [ttyd 1.7.7](https://github.com/tsl0922/ttyd/releases/tag/1.7.7) at `/usr/local/bin/ttyd`. Configure both directory paths in the trusted launcher. Use canonical paths owned by the worker UID with mode `0700`. The worker starts `agy` with a clean headless environment and checks only the metadata of its private native login file. Only the official CLI handles the contents.
2. Run [the browser terminal launcher](./serve-file-profile.sh) as that UID. It binds to loopback in the isolated worker network. Expose it through the trusted HTTPS identity proxy. The proxy must enforce the **one assigned member** on HTTP and WebSocket upgrades, strip any incoming `X-Okou-Authenticated-Member` header, and set it only after authentication. Preserve the public Host and Origin. Use `Cache-Control: no-store`, disable terminal recording, body and query logging, and expose no direct route to the worker. A binding UUID is an identifier and grants no access. Use a separate origin per assignment.
3. Configure the production API's existing `ANTIGRAVITY_SUBSCRIPTION_WORKERS` variable with the actual `orgId`, `userId`, `machineId` and `loginOrigin` (the HTTPS origin without a trailing slash, path, userinfo or query). This replaces `loginHost` for this member. Check anonymous requests and another member are denied by the gateway, including on WebSockets, before enabling the staff switch for the tester.
4. In **Settings → Models → Google AI (Antigravity)** choose **Connect account**, then **Open Google sign-in terminal** and press Enter. Follow the official CLI's instructions and return to **Check sign-in**. To verify restore, stop the worker, start a new instance with a clean home, reattach only the native login and the separate Okou control state, and open the terminal again. Enter confirms the restored session without a model request. Typing `verify` explicitly spends subscription quota for the three fixed model probes. Typing `logout` revokes the binding and removes the native login. Refresh Settings to see the change. An idle menu closes after 15 minutes.
5. Removing the binding in Settings revokes model checks immediately. To purge an offline worker, remove its private native volume and control directory before retiring or reassigning it. Disable its ingress and machine identity. Allocate a new empty volume and identity for another member.

## Existing SSH and Secret Service worker

1. Assign one dedicated Linux user, private home and persistent Secret Service login keyring to the member. Give the worker its own D-Bus user session and unlock its keyring using the deployment's secret manager or PAM. Keep the home, keyring and D-Bus socket outside every job sandbox. On Linux, changing only `HOME` does not isolate an existing desktop keyring.
2. Install the pinned `/usr/local/bin/agy` using the same release and SHA-512 verification as the [Runner template](../../crates/runner/scripts/build-template.sh). Install Python 3.11 or newer. Install [the worker entry point](../../scripts/connect-antigravity-subscription.py) and [its companion module](../../scripts/antigravity_personal.py) together in the root-owned directory `/opt/okou/antigravity`. Start with a new native login profile. Assign a new OS account and keyring when reassigning a machine to another person.
3. Allocate an individual Clerk machine identity and authorize it to call the environment's receiving Okou machine. Configure the API's existing `OKOU_MACHINE_SECRET_KEY`. Set the `ANTIGRAVITY_SUBSCRIPTION_WORKERS` GitHub Actions variable to a JSON array in the deployment's environment. Use the `production` GitHub Environment for production assignments. The next API deployment picks up that environment's assignments. Each entry is unique by both member and machine.

   ```json
   [
     {
       "orgId": "org_example",
       "userId": "user_example",
       "machineId": "mch_example",
       "loginHost": "tester@agy-staging.example.com"
     }
   ]
   ```

4. Configure the trusted worker launcher with `OKOU_ANTIGRAVITY_API_ORIGIN` set to that environment's HTTPS API origin. Set `OKOU_ANTIGRAVITY_M2M_TOKEN_FILE` to a file holding the worker's current short-lived Clerk M2M bearer token. Supply and rotate this file through the deployment's credential manager. Its contents never enter the native CLI environment.
5. Grant that member SSH access only to the enrollment command. For an OpenSSH deployment, configure a root-owned authorized-keys file with an entry of the following form. Its forced command invokes the root-owned launcher with the two deployment settings and the correct user bus. Configure no shell access through other authentication methods, no user environment or user startup scripts and no alternate usable key on this account. The SSH host key should already be trusted by the member.

   ```text
   restrict,pty,command="/usr/local/libexec/okou-agy-login" ssh-ed25519 <member-public-key>
   ```

Install the following root-owned launcher at `/usr/local/libexec/okou-agy-login`. Replace the example API origin and token-file path with the staging deployment values. Use an OS session that provides the member's unlocked Secret Service on the user bus.

```sh
#!/bin/sh
set -eu
export PATH=/usr/local/bin:/usr/bin:/bin
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
export OKOU_ANTIGRAVITY_API_ORIGIN="https://api.staging.example.com"
export OKOU_ANTIGRAVITY_M2M_TOKEN_FILE="/run/credentials/okou-agy-$(id -u)/m2m-token"
exec /usr/bin/python3 -E -s /opt/okou/antigravity/connect-antigravity-subscription.py
```

The program reads `SSH_ORIGINAL_COMMAND` and parses only an operation and a UUID. Validate the empty keyring with `verify-antigravity-subscription.py --check-login` before handing the terminal to the member. An unpaired, already signed-in keyring cannot be claimed.

## Check a personal subscription locally

A tester can check the Google account before a staging worker is provisioned. On the account owner's computer, use the official `agy 1.5.15`, Python 3.11 or newer and a checkout of this revision. Use the following commands at the repository root.

```sh
agy acp --login
python3 scripts/verify-antigravity-subscription.py --check-login
```

The second command opens an empty native session without sending a prompt. Record the plan, time and available quota in Google. To send one fixed prompt each to Neon, Carbon and Hydrogen, use the following command.

```sh
python3 scripts/verify-antigravity-subscription.py
```

Record each model's result and the usage that Google displays after the test. This local check covers the Google account and native CLI. Use the steps below to verify the same account through Okou's member binding.

## Member acceptance

1. Enable the staff Antigravity Lab switch, then open **Settings → Models → Google AI (Antigravity) → Connect account**. The CLI equivalent is `okou subscription antigravity connect` in a member-authenticated CLI session.
2. Run the displayed SSH command in your terminal. Select your personal Google AI Pro or Ultra account in Google's browser sign-in and enter any one-time code directly into the official CLI. In Okou, choose **Check sign-in**. The worker confirms the grant only after a new official CLI process opens an authenticated session without sending a model prompt.
3. Record the plan, current subscription usage and time in Google's account UI. After Settings shows **Connected**, run the verification command it displays, `ssh -t -- <assigned-host> verify <binding-id>`. This explicitly consumes subscription quota and sends one fixed, tool-free prompt each to Neon, Carbon and Hydrogen at medium effort. The worker rechecks the grant before each prompt and checks the model, conversation and terminal response. Check the same Google account afterward. Model replies alone do not establish the subscription tier or quota charged.
4. Run `ssh -t -- <assigned-host> logout <binding-id>` to revoke the Okou binding and purge the native Google login. Alternatively, disconnect first in Settings to revoke the Okou binding immediately, then use the same terminal logout command to clear the keyring. A fresh sign-in receives a new binding ID. The switch can be off when disconnecting.
5. For workspace execution acceptance, use separate disposable Okou Guests for the three models. Verify one edit and test in each Guest, the exact bound account and model, cancellation, revocation before dispatch, and a second member's isolation. The login worker only exposes fixed acceptance prompts. General chat routes require a trusted transport to the assigned Guest before enablement.
