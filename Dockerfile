# syntax=docker/dockerfile:1

FROM couchdb:3.5.2.1 AS couchdb
COPY config/livesync.ini /opt/couchdb/etc/local.ini

FROM denoland/deno:2.9.5 AS init
WORKDIR /app
COPY --chown=deno:deno scripts/couchdb-init.ts /app/couchdb-init.ts
# "deno" is the upstream image's own user; pinning the numeric uid would break
# silently if that image ever renumbers it.
# hadolint ignore=DL3066
USER deno
# deno check, not deno cache: `deno cache` only resolves dependencies and does
# not type-check, so it accepted a deliberate `const x: number = "string"`
# without complaint. `deno run` does not type-check either, which left the
# types in this script unenforced at every stage between edit and production.
RUN deno check /app/couchdb-init.ts
ENTRYPOINT ["deno", "run", "--cached-only", "--allow-env", "--allow-net", "/app/couchdb-init.ts"]
