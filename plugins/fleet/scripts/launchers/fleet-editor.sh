#!/usr/bin/env sh
set -eu
export FLEET_ORIGINAL_EDITOR_JSON='__FLEET_ORIGINAL_EDITOR_JSON__'
exec '__FLEET_NODE__' '__FLEET_CONSOLE__' "$@"
