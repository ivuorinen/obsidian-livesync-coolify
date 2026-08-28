#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

# Scope the empty-file check to files git would actually keep. Scanning the
# whole working tree reported a contributor's empty .env — a file this
# repository deliberately ignores — as "Repository contains empty files",
# sending them to look for a problem in the wrong tree.
#
# --cached --others --exclude-standard covers tracked plus untracked-but-not-
# ignored files, and unlike `git ls-files` alone it works before the first
# commit, which is when a fallback to a bare `find` would otherwise kick in
# and reintroduce exactly the noise this replaced.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  empty_files="$(git ls-files -z --cached --others --exclude-standard \
    | xargs -0 -r -I{} find {} -maxdepth 0 -type f -size 0 -print)"
else
  empty_files="$(find . -type f -not -path './.git/*' -size 0 -print)"
fi
if [[ -n "$empty_files" ]]; then
  echo "Repository contains empty files:" >&2
  printf '%s\n' "$empty_files" >&2
  exit 1
fi

# Linters are skipped when absent rather than installed: this script runs on
# contributor machines as well as in CI, and must not mutate either.
run_linter() {
  local tool="$1"
  shift
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "skipping $tool (not installed)"
    return 0
  fi
  echo "running $tool"
  "$tool" "$@"
}

run_linter hadolint Dockerfile
run_linter shellcheck scripts/validate.sh
run_linter actionlint
run_linter yamllint docker-compose.yml .github/

# Type-check, lint, format-check and unit-test the provisioning script. Falls
# back to the pinned Deno image so the checks run identically whether or not
# Deno is installed locally. --network none proves the script keeps its
# zero-remote-dependency property; a new import makes this fail loudly.

# Read the Deno image out of the Dockerfile rather than pinning it again here.
# Two pins drift: this one would keep type-checking against an old Deno long
# after the image the code actually ships on had moved.
deno_image="$(grep -oE 'denoland/deno:[0-9]+\.[0-9]+\.[0-9]+' Dockerfile | head -1)"
if [[ -z "$deno_image" ]]; then
  echo "could not find a pinned denoland/deno image in Dockerfile" >&2
  exit 1
fi

deno_exec() {
  if command -v deno >/dev/null 2>&1; then
    deno "$@"
  else
    docker run --rm -v "$repo_root:/w" -w /w --network none "$deno_image" deno "$@"
  fi
}

echo "type-checking, linting and testing scripts/couchdb-init.ts"
deno_exec check scripts/couchdb-init.ts scripts/couchdb-init.test.ts
deno_exec lint scripts/
deno_exec fmt --check scripts/ deno.json
deno_exec test scripts/couchdb-init.test.ts

# Coolify's parseEnvVariable() only recognises a SERVICE_* magic variable when
# the whole name has three underscores or fewer; past that it generates nothing
# and the variable arrives empty, which CouchDB reports only by exiting at
# startup. Catching it here costs one grep instead of a failed deployment.
echo "checking Coolify magic variable names"
if bad=$(grep -oE 'SERVICE_[A-Z0-9_]+' docker-compose.yml | sort -u |
  awk -F_ 'NF > 4 { print $0 }'); then
  if [ -n "$bad" ]; then
    echo "Coolify will not generate these; their identifiers contain an underscore:" >&2
    echo "$bad" | sed 's/^/  - /' >&2
    exit 1
  fi
fi

export SERVICE_PASSWORD_64_COUCHDBADMIN="${SERVICE_PASSWORD_64_COUCHDBADMIN:-ci-admin-password-6b2e1e5343ef4eeca4ce2e345db338c2}"
export SERVICE_PASSWORD_64_LIVESYNC="${SERVICE_PASSWORD_64_LIVESYNC:-ci-livesync-password-f2d50c3c778346b6a30bb98dc8f73352}"
export SERVICE_FQDN_COUCHDB_5984="${SERVICE_FQDN_COUCHDB_5984:-livesync.invalid}"

# exclude_from_hc is a supported Coolify Compose extension but not part of the
# upstream Docker Compose schema, so remove only that key for local validation.
validation_compose=.docker-compose.validate.yml
validation_users=.docker-compose.validate-users.yml
integration_project="obsidian-livesync-validate-$$"

cleanup() {
  docker compose -p "$integration_project" -f "$validation_compose" -f "$validation_users" \
    down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$validation_compose" "$validation_users"
}
trap cleanup EXIT

sed '/^[[:space:]]*exclude_from_hc:[[:space:]]/d' docker-compose.yml >"$validation_compose"
docker compose -f "$validation_compose" config --quiet

# Two people, so the check can prove isolation rather than just access. The
# shipped roster has one person, which cannot distinguish "alice reaches her
# vault" from "alice reaches every vault".
alice_password="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
bob_password="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
outsider_password="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"

cat >"$validation_users" <<YAML
---
services:
  couchdb-init:
    environment:
      - LIVESYNC_USERS=alice,bob
      - LIVESYNC_PASSWORD_ALICE=$alice_password
      - LIVESYNC_PASSWORD_BOB=$bob_password
YAML

docker build --target couchdb --tag obsidian-livesync-couchdb:validate .
docker build --target init --tag obsidian-livesync-init:validate .

# A leftover single-user variable must abort provisioning, not be ignored:
# silently dropping COUCHDB_DATABASE would provision an empty vault while
# leaving the operator's intended one untouched, which reads as data loss.
# Cheap to check — this fails during config parsing, before any network call.
echo "checking that removed single-user variables are rejected"
for removed in COUCHDB_DATABASE LIVESYNC_USER LIVESYNC_PASSWORD; do
  if docker run --rm \
    -e COUCHDB_INTERNAL_URL=http://couchdb:5984 \
    -e COUCHDB_ADMIN_USER=admin -e COUCHDB_ADMIN_PASSWORD=unused \
    -e LIVESYNC_USERS=alice -e LIVESYNC_PASSWORD_ALICE=unused \
    -e "$removed=leftover" \
    obsidian-livesync-init:validate >/dev/null 2>&1; then
    echo "$removed was accepted; it must abort provisioning" >&2
    exit 1
  fi
  echo "  ok   $removed rejected"
done

# Integration check. Provisioning runs twice against the same CouchDB, because
# the second run is the state every redeploy is actually in — and the run that
# previously failed after 122 seconds once configureServer() had closed /_up to
# anonymous requests.
compose_integration() {
  docker compose -p "$integration_project" -f "$validation_compose" -f "$validation_users" "$@"
}

echo "starting CouchDB for the provisioning check"
compose_integration up -d couchdb

echo "provisioning run 1 of 2 (fresh databases)"
compose_integration run --rm couchdb-init

echo "provisioning run 2 of 2 (already provisioned — must be idempotent)"
compose_integration run --rm couchdb-init

# Each person must reach their own vault and be refused on everyone else's.
# Access alone would pass even if every account could read every database, so
# the refusals are the half of this matrix that carries the guarantee.
# An empty members block in a _security object means "any valid user" in
# CouchDB, which is exactly the failure this catches.
#
# Passwords are generated per run rather than written here, so this file holds
# no credential-shaped literal for a secret scanner to flag or a reader to
# mistake for a real one.
echo "checking per-person vault isolation"

# shellcheck disable=SC2016
# Single quotes are deliberate: COUCHDB_USER, COUCHDB_PASSWORD and the
# per-person passwords must expand inside the container, not on this host.
ALICE_PASSWORD="$alice_password" BOB_PASSWORD="$bob_password" \
  OUTSIDER_PASSWORD="$outsider_password" compose_integration exec -T \
  -e ALICE_PASSWORD -e BOB_PASSWORD -e OUTSIDER_PASSWORD couchdb sh -c '
  set -eu
  base="http://127.0.0.1:5984"
  admin_user="$COUCHDB_USER"
  admin_password="$COUCHDB_PASSWORD"
  outsider="org.couchdb.user:validateoutsider"
  failed=0

  curl -fsS --user "$admin_user:$admin_password" -X PUT "$base/_users/$outsider" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"validateoutsider\",\"password\":\"$OUTSIDER_PASSWORD\",\"roles\":[],\"type\":\"user\"}" \
    >/dev/null

  check() { # user password database expected-status
    status="$(curl -s -o /dev/null -w "%{http_code}" --user "$1:$2" "$base/$3")"
    if [ "$status" = "$4" ]; then
      echo "  ok   $1 -> $3 : $status"
    else
      echo "  FAIL $1 -> $3 : $status (expected $4)" >&2
      failed=1
    fi
  }

  check alice "$ALICE_PASSWORD" vault-alice 200
  check alice "$ALICE_PASSWORD" vault-bob   403
  check bob   "$BOB_PASSWORD"   vault-bob   200
  check bob   "$BOB_PASSWORD"   vault-alice 403
  check validateoutsider "$OUTSIDER_PASSWORD" vault-alice 403
  check validateoutsider "$OUTSIDER_PASSWORD" vault-bob   403

  rev="$(curl -s --user "$admin_user:$admin_password" "$base/_users/$outsider" \
    | sed -n "s/.*\"_rev\":\"\([^\"]*\)\".*/\1/p")"
  curl -fsS --user "$admin_user:$admin_password" -X DELETE \
    "$base/_users/$outsider?rev=$rev" >/dev/null

  [ "$failed" -eq 0 ] || exit 1
'

if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git diff --check
fi

echo "Repository validation passed."
