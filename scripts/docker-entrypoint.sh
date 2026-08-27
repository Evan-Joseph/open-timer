#!/usr/bin/env sh
set -eu

data_dir="${CLOCK_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$data_dir"
  chown -R opentimer:opentimer "$data_dir"
  exec gosu opentimer "$@"
fi

exec "$@"
