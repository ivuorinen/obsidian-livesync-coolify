# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for this repository when it is enabled. Do not include credentials, vault contents, CouchDB dumps, LiveSync setup URIs, or encryption passphrases in a public issue.

If private vulnerability reporting is not enabled, open a public issue containing only a minimal description and ask the maintainer for a private contact channel before sharing sensitive reproduction details.

## Deployment security assumptions

This stack assumes that CouchDB port 5984 is reachable externally only through Coolify's HTTPS reverse proxy. The Compose file uses `expose`, not a host `ports` mapping.

The CouchDB server administrator account is reserved for provisioning and administration. Each person listed in `LIVESYNC_USERS` gets their own account, granted database-admin rights on their own `vault-<name>` database and nothing else. A database administrator cannot list databases, create or delete them, read `_users`, or change server-wide configuration.

## Multi-person deployments

People are separated by CouchDB access control, not by cryptography. Each person's vault is unreadable to the others, and `scripts/validate.sh` asserts those refusals on every run.

A CouchDB **server** administrator can read any vault whose owner has not enabled end-to-end encryption. If you host vaults for other people, treat that as the trust boundary and tell them: whoever holds `SERVICE_PASSWORD_64_COUCHDB_ADMIN` can read unencrypted vaults.

Self-hosted LiveSync end-to-end encryption is separate from CouchDB authentication and is each person's own choice, set in their own Obsidian client. The server neither sets nor knows the passphrase. Use a strong, unique passphrase and store it outside this repository.

## Secrets

Never commit Coolify-generated values for `SERVICE_PASSWORD_64_COUCHDB_ADMIN` or for any person's `SERVICE_PASSWORD_64_<NAME>`. They are intentionally generated and stored by Coolify at deployment time.

Removing someone from `LIVESYNC_USERS` stops them being provisioned but does not revoke them: their CouchDB account and vault database remain until deleted by hand. Delete the account first if the intent is to cut off access.
