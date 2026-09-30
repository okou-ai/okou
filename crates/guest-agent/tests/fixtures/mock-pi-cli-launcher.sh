#!/bin/sh
# Enabled only in debug builds with guest-agent/cli-test-fixtures.
# The target is a local mock executable provided by the integration test.
exec "${OKOU_TEST_CLI_SCRIPT_PATH:?missing local CLI fixture}" "$@"
