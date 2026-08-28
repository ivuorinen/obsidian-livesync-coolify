#!/usr/bin/env bash
# Run a deno subcommand against this repository, falling back to the pinned
# Deno image from the Dockerfile when deno is not installed locally, so the
# checks run identically on a contributor machine, in a hook and in CI.
#
# --network none proves the provisioning script keeps its zero-remote-
# dependency property; a new import makes this fail loudly.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if command -v deno >/dev/null 2>&1; then
  exec deno "$@"
fi

# Read the image out of the Dockerfile rather than pinning it again here. Two
# pins drift: this one would keep type-checking against an old Deno long after
# the image the code actually ships on had moved.
deno_image="$(grep -oE 'denoland/deno:[0-9]+\.[0-9]+\.[0-9]+' Dockerfile | head -1)"
if [[ -z "$deno_image" ]]; then
  echo "could not find a pinned denoland/deno image in Dockerfile" >&2
  exit 1
fi

exec docker run --rm -v "$repo_root:/w" -w /w --network none "$deno_image" deno "$@"
