#!/bin/sh
# Run behind the member-authenticated HTTPS proxy in this worker's own network namespace.
set -eu
umask 077
: "${OKOU_ANTIGRAVITY_FILE_HOME:?Set the private native profile directory}"
: "${OKOU_ANTIGRAVITY_BINDING_DIR:?Set the persistent worker binding directory}"
: "${OKOU_ANTIGRAVITY_API_ORIGIN:?Set the worker's HTTPS Okou API origin}"
: "${OKOU_ANTIGRAVITY_M2M_TOKEN_FILE:?Set the worker's rotating machine token file}"
exec /usr/local/bin/ttyd \
  --interface lo --port 7681 --auth-header X-Okou-Authenticated-Member \
  --check-origin --writable --url-arg --max-clients 1 --debug 0 -- \
  /usr/bin/python3 -E -s /opt/okou/antigravity/connect-antigravity-subscription.py browser
