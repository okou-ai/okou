# Antigravity personal subscription worker

The internal sign-in worker associates a member's Okou account with an official Google login. The private keyring stays on the worker. Its terminal supports enrollment, a three-model acceptance check and logout. It accepts no workspace, model prompt or arbitrary command.

## Provision a pilot member

1. Assign one dedicated Linux user, private home and persistent Secret Service login keyring to the member. Give the worker its own D-Bus user session and unlock its keyring using the deployment's secret manager or PAM. Keep the home, keyring and D-Bus socket outside every job sandbox. On Linux, changing only `HOME` does not isolate an existing desktop keyring.
2. Install the pinned `/usr/local/bin/agy` using the same release and SHA-512 verification as the [Runner template](../../crates/runner/scripts/build-template.sh). Install Python 3.11 or newer. Install [the worker entry point](../../scripts/connect-antigravity-subscription.py) and [its companion module](../../scripts/antigravity_personal.py) together in the root-owned directory `/opt/okou/antigravity`. Start with a new native login profile. Assign a new OS account and keyring when reassigning a machine to another person.
3. Allocate an individual Clerk machine identity and authorize it to call the environment's receiving Okou machine. Configure the API's existing `OKOU_MACHINE_SECRET_KEY` and set `ANTIGRAVITY_SUBSCRIPTION_WORKERS` to a JSON array. Each entry is unique by both member and machine.

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
3. Record the plan, current subscription usage and time in Google's account UI. To exercise the verified binding, run `ssh -t -- <assigned-host> verify <binding-id>`. This explicitly consumes subscription quota and sends one fixed, tool-free prompt each to Neon, Carbon and Hydrogen at medium effort. The worker rechecks the grant before each prompt and checks the model, conversation and terminal response. Check the same Google account afterward. Model replies alone do not establish the subscription tier or quota charged.
4. Run `ssh -t -- <assigned-host> logout <binding-id>` to revoke the Okou binding and purge the native Google login. Alternatively, disconnect first in Settings to revoke the Okou binding immediately, then use the same terminal logout command to clear the keyring. A fresh sign-in receives a new binding ID. The switch can be off when disconnecting.
5. For workspace execution acceptance, use separate disposable Okou Guests for the three models. Verify one edit and test in each Guest, the exact bound account and model, cancellation, revocation before dispatch, and a second member's isolation. The login worker only exposes fixed acceptance prompts. General chat routes require a trusted transport to the assigned Guest before enablement.
