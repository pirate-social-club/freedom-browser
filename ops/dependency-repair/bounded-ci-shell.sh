#!/bin/bash
# Run GitHub step scripts with the pinned Node PATH captured before sudo.
set -euo pipefail
[[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ ]]
[[ ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]+$ ]]
test "$#" -eq 1
test -f "$1"
test -d "$GITHUB_WORKSPACE"
exec sudo systemd-run \
  --unit="freedom-upstream-validation-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.service" \
  --wait --pipe --collect --uid="$(id -u)" --gid="$(id -g)" \
  --working-directory="$GITHUB_WORKSPACE" \
  --property=CPUQuota=100% --property=AllowedCPUs=0 --property=CPUAffinity=0 \
  --property=Nice=19 --property=MemoryMax=3221225472 --property=MemorySwapMax=0 \
  --property=RuntimeMaxSec=600 --property=TimeoutStopSec=5 --property=KillMode=control-group \
  --setenv="PATH=$PATH" --setenv=CI=1 --setenv=FREEDOM_ELECTRON_NET_TEST=1 \
  /bin/bash --noprofile --norc -eo pipefail "$1"
