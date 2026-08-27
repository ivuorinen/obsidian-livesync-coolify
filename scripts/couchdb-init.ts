/**
 * One-shot CouchDB provisioning for Obsidian Self-hosted LiveSync.
 *
 * Provisions one vault database per person listed in LIVESYNC_USERS, each
 * reachable only by its owner. Runs to completion on every deploy and must
 * therefore be idempotent: it is re-executed against a server it has already
 * configured, not only against a fresh one. Each step below states what it
 * does on the second run, because that is the state a running deployment
 * spends all of its time in.
 */

/**
 * LiveSync's remote schema version and version-marker document id, mirroring
 * the VER and VERSIONING_DOCID constants of @vrtmrz/livesync-commonlib. The
 * document id carries upstream's spelling of "obsydian"; it is a wire value,
 * not a typo to correct.
 *
 * These are inlined rather than imported because the library pulls a
 * 28-package tree (the AWS S3 SDK, a nostr transport, eleven PouchDB
 * packages) to supply two constants and two HTTP requests this file already
 * knows how to make. Bump both together when tracking a new LiveSync release.
 */
const LIVESYNC_SCHEMA_VERSION = 12;
const LIVESYNC_VERSION_DOCID = "obsydian_livesync_version";

const DEFAULT_ORIGINS = "app://obsidian.md,capacitor://localhost,http://localhost";
const CORS_HEADERS = "accept, authorization, content-type, origin, referer";
const CORS_METHODS = "GET, PUT, POST, HEAD, DELETE";

/**
 * Single-user variables from before per-person vaults, mapped to what
 * replaces them. Silently ignoring one would provision a deployment the
 * operator did not describe — most dangerously, ignoring COUCHDB_DATABASE
 * would leave their intended vault untouched and empty.
 */
const REPLACED_VARIABLES: ReadonlyArray<[string, string]> = [
  ["LIVESYNC_USER", "LIVESYNC_USERS (a comma-separated roster)"],
  ["LIVESYNC_PASSWORD", "LIVESYNC_PASSWORD_<NAME>, one per person"],
  ["COUCHDB_DATABASE", "a vault-<name> database per person, derived automatically"],
];

export function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function normaliseBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

export function validateDatabaseName(value: string): string {
  if (!/^[a-z][a-z0-9_$()+-]*$/.test(value)) {
    throw new Error(
      `derived database name '${value}' must begin with a lower-case letter and contain only lower-case letters, digits, _, $, (, ), +, or -`,
    );
  }
  return value;
}

export function validateUserName(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(
      `LIVESYNC_USERS entry '${value}' may contain only letters, digits, dot, underscore, and hyphen`,
    );
  }
  return value;
}

/**
 * Builds an HTTP Basic credential.
 *
 * btoa() encodes Latin-1 code units, so handing it a non-ASCII password
 * yields bytes CouchDB will not match — it expects UTF-8 — and throws
 * outright above U+00FF. Encoding to UTF-8 first avoids a silent 401 that
 * reads as a wrong password rather than a wrong encoding.
 */
export function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

/** Environment variable holding a person's password, e.g. alice -> LIVESYNC_PASSWORD_ALICE. */
export function passwordVariableFor(user: string): string {
  return `LIVESYNC_PASSWORD_${user.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * A person's vault database name, e.g. alice.smith -> vault-alice-smith.
 *
 * The constant "vault-" prefix is load-bearing: CouchDB requires a database
 * name to begin with a lower-case letter, and prefixing means no username —
 * including one starting with a digit — can derive an invalid name.
 */
export function databaseFor(user: string): string {
  return `vault-${user.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
}

export interface LiveSyncAccount {
  user: string;
  password: string;
  database: string;
  authorization: string;
}

/**
 * Turns the LIVESYNC_USERS roster into one account per person.
 *
 * Validates the whole roster before the caller touches CouchDB, so a typo in
 * the last name does not leave the first few people half-provisioned.
 *
 * Rejects names that collide after normalisation: "Alice" and "alice" derive
 * the same database and the same password variable, so accepting both would
 * silently hand two people one vault and one credential.
 *
 * Takes an env lookup rather than reading Deno.env directly so it is testable
 * without granting --allow-env.
 */
export function parseAccounts(
  usersValue: string,
  lookupEnv: (name: string) => string | undefined,
): LiveSyncAccount[] {
  const names = usersValue.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new Error("LIVESYNC_USERS must list at least one user, for example: alice,bob");
  }

  // Every problem in the roster is collected and reported together. Failing on
  // the first one costs a redeploy per typo, and adding three people at once
  // is exactly when several are in flight — a missing password for the first
  // name would otherwise hide a malformed name further down the list.
  const problems: string[] = [];
  const accounts: LiveSyncAccount[] = [];
  const claimedBy = new Map<string, string>();

  for (const user of names) {
    try {
      validateUserName(user);
    } catch (error) {
      // Skip the password lookup: its variable name derives from this name,
      // so reporting it too would just be noise about a name already rejected.
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    const database = databaseFor(user);
    const owner = claimedBy.get(database);
    if (owner !== undefined) {
      problems.push(
        `LIVESYNC_USERS entries '${owner}' and '${user}' both derive database '${database}'; ` +
          "give them names that differ by more than case, dots, or underscores",
      );
      continue;
    }
    claimedBy.set(database, user);

    const variable = passwordVariableFor(user);
    const password = lookupEnv(variable)?.trim();
    if (!password) {
      problems.push(`${variable} is required for LIVESYNC_USERS entry '${user}'`);
      continue;
    }

    accounts.push({
      user,
      password,
      database: validateDatabaseName(database),
      authorization: basicAuth(user, password),
    });
  }

  if (problems.length > 0) {
    throw new Error(
      `LIVESYNC_USERS could not be provisioned:\n  - ${problems.join("\n  - ")}`,
    );
  }

  return accounts;
}

type SecurityEntry = { names?: string[]; roles?: string[] };
type SecurityObject = {
  admins?: SecurityEntry;
  members?: SecurityEntry;
  [key: string]: unknown;
};

function normaliseSecurityEntry(value: SecurityEntry | undefined): Required<SecurityEntry> {
  return {
    names: Array.isArray(value?.names) ? [...value.names] : [],
    roles: Array.isArray(value?.roles) ? [...value.roles] : [],
  };
}

/**
 * Computes the database security object granting `user` database-admin rights.
 *
 * An empty members block means "every authenticated user" in CouchDB, so this
 * never returns one: the user is added to members as well as admins, and
 * members.roles falls back to _admin. Passing the existing object through
 * untouched was a real defect — on a database whose _security was empty (one
 * restored or replicated in, rather than created by this stack) the result
 * granted every account in _users full read and write on the vault. The
 * `default_security = admin_only` setting in config/livesync.ini masks that
 * for databases this stack creates itself; the invariant must not depend on
 * it.
 *
 * Database admin, not plain member, is required: LiveSync builds indexes via
 * pouchdb-find, and CouchDB refuses design documents to members with
 * "You are not a db or server admin."
 */
export function mergeSecurity(security: SecurityObject, user: string): SecurityObject {
  const admins = normaliseSecurityEntry(security.admins);
  const members = normaliseSecurityEntry(security.members);

  if (!admins.names.includes(user)) admins.names.push(user);
  if (!members.names.includes(user)) members.names.push(user);
  if (members.roles.length === 0) members.roles.push("_admin");

  return { ...security, admins, members };
}

interface Config {
  baseUrl: string;
  adminUser: string;
  adminPassword: string;
  adminAuthorization: string;
  corsOrigins: string;
  accounts: LiveSyncAccount[];
}

/**
 * Reads and validates the environment.
 *
 * Deliberately called from main() rather than at module scope: importing this
 * file from a test must not throw on a missing COUCHDB_INTERNAL_URL, and must
 * not begin provisioning anything.
 */
function readConfig(): Config {
  for (const [removed, replacement] of REPLACED_VARIABLES) {
    if (Deno.env.get(removed)?.trim()) {
      throw new Error(`${removed} is no longer supported; use ${replacement}`);
    }
  }

  const adminUser = requiredEnv("COUCHDB_ADMIN_USER");
  const adminPassword = requiredEnv("COUCHDB_ADMIN_PASSWORD");

  return {
    baseUrl: normaliseBaseUrl(requiredEnv("COUCHDB_INTERNAL_URL")),
    adminUser,
    adminPassword,
    adminAuthorization: basicAuth(adminUser, adminPassword),
    corsOrigins: Deno.env.get("CORS_ORIGINS")?.trim() || DEFAULT_ORIGINS,
    accounts: parseAccounts(requiredEnv("LIVESYNC_USERS"), (name) => Deno.env.get(name)),
  };
}

let config: Config;

function url(path: string): string {
  return `${config.baseUrl}${path}`;
}

async function adminRequest(
  path: string,
  init: RequestInit = {},
  acceptedStatuses: readonly number[] = [],
): Promise<{ response: Response; body: string }> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", config.adminAuthorization);
  headers.set("Accept", "application/json");
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url(path), { ...init, headers });
  const body = await response.text();
  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    throw new Error(`${init.method ?? "GET"} ${path} failed with HTTP ${response.status}: ${body}`);
  }
  return { response, body };
}

/**
 * Blocks until CouchDB answers /_up.
 *
 * The probe is authenticated. configureServer() sets
 * chttpd/require_valid_user, so from the first successful run onwards an
 * anonymous /_up returns 401 — an unauthenticated probe here spun the full
 * 60 attempts and killed every subsequent deploy after 122 seconds with
 * "did not become ready in time", while CouchDB was healthy the entire time.
 *
 * The last failure is reported so a persistent 401 or a DNS error is named
 * rather than flattened into the timeout message.
 */
async function waitForCouchDB(): Promise<void> {
  let lastFailure = "no response";

  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const response = await fetch(url("/_up"), {
        headers: { Authorization: config.adminAuthorization, Accept: "application/json" },
      });
      const body = await response.text();
      if (response.ok && body.includes('"status":"ok"')) return;
      lastFailure = `HTTP ${response.status}: ${body.slice(0, 200)}`;
    } catch (error) {
      // CouchDB may still be starting; keep the reason for the timeout message.
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(`CouchDB did not become ready in time (last failure: ${lastFailure})`);
}

async function configureSingleNode(): Promise<void> {
  const current = await adminRequest("/_cluster_setup");
  try {
    const setup = JSON.parse(current.body) as { state?: string };
    if (setup.state === "single_node_enabled") {
      console.log("CouchDB single-node mode is already enabled.");
      return;
    }
  } catch {
    // Fall through to the idempotent setup request below.
  }

  const { response, body } = await adminRequest(
    "/_cluster_setup",
    {
      method: "POST",
      body: JSON.stringify({
        action: "enable_single_node",
        username: config.adminUser,
        password: config.adminPassword,
        bind_address: "0.0.0.0",
        port: 5984,
        singlenode: true,
      }),
    },
    [400, 409],
  );

  if (
    !response.ok &&
    !([400, 409].includes(response.status) && /already|finished|single_node_enabled/i.test(body))
  ) {
    throw new Error(`Single-node setup failed with HTTP ${response.status}: ${body}`);
  }
}

async function setConfig(section: string, key: string, value: string): Promise<void> {
  const path = `/_node/_local/_config/${encodeURIComponent(section)}/${encodeURIComponent(key)}`;
  await adminRequest(path, { method: "PUT", body: JSON.stringify(value) });
}

/**
 * Applies authentication, CORS, and the LiveSync request-size limits.
 *
 * Server-wide, so it runs once regardless of how many people are provisioned.
 * These are the only place CORS is configured: config/livesync.ini is loaded
 * before local.d/docker.ini and would be silently overridden, so restating
 * them there leaves the repository documenting an allow-list the server does
 * not enforce.
 */
async function configureServer(): Promise<void> {
  const settings: Array<[string, string, string]> = [
    ["chttpd", "require_valid_user", "true"],
    ["chttpd_auth", "require_valid_user", "true"],
    // Keeps /_up answerable without credentials so container health checks and
    // the Coolify proxy can probe liveness once the two settings above close
    // the rest of the endpoint.
    ["chttpd", "require_valid_user_except_for_up", "true"],
    ["httpd", "WWW-Authenticate", 'Basic realm="couchdb"'],
    ["httpd", "enable_cors", "true"],
    ["chttpd", "enable_cors", "true"],
    ["couchdb", "max_document_size", "50000000"],
    ["cors", "credentials", "true"],
    ["cors", "origins", config.corsOrigins],
    ["cors", "headers", CORS_HEADERS],
    ["cors", "methods", CORS_METHODS],
    ["cors", "max_age", "3600"],
  ];

  for (const [section, key, value] of settings) {
    await setConfig(section, key, value);
  }
}

async function createDatabase(account: LiveSyncAccount): Promise<void> {
  await adminRequest(`/${encodeURIComponent(account.database)}`, { method: "PUT" }, [412]);
}

/**
 * Ensures a vault database carries the LiveSync version marker.
 *
 * A missing marker means a fresh database and the marker is written. A marker
 * at a different version means the database belongs to another LiveSync
 * generation; provisioning refuses it rather than migrating, because
 * migration is the client's job and doing it here would rewrite a vault this
 * script does not own.
 */
async function initialiseLiveSyncDatabaseVersion(account: LiveSyncAccount): Promise<void> {
  const path = `/${encodeURIComponent(account.database)}/${LIVESYNC_VERSION_DOCID}`;
  const { response, body } = await adminRequest(path, {}, [404]);

  if (response.status === 404) {
    await adminRequest(path, {
      method: "PUT",
      body: JSON.stringify({ version: LIVESYNC_SCHEMA_VERSION, type: "versioninfo" }),
    });
    return;
  }

  const existing = JSON.parse(body) as { type?: string; version?: number };
  if (existing.type !== "versioninfo" || existing.version !== LIVESYNC_SCHEMA_VERSION) {
    throw new Error(
      `Database '${account.database}' is at LiveSync schema version ${existing.version} ` +
        `but this stack provisions version ${LIVESYNC_SCHEMA_VERSION}`,
    );
  }
}

/**
 * Creates a person's account, or resets its password if it has drifted.
 *
 * The /_session probe is what makes a re-run cheap: when the stored password
 * already matches, the user document is left alone rather than rewritten with
 * a new _rev on every deploy.
 */
async function upsertLiveSyncUser(account: LiveSyncAccount): Promise<void> {
  const documentId = `org.couchdb.user:${account.user}`;
  const path = `/_users/${encodeURIComponent(documentId)}`;
  const existingResult = await adminRequest(path, {}, [404]);

  let existing: Record<string, unknown> | undefined;
  if (existingResult.response.status === 200) {
    existing = JSON.parse(existingResult.body) as Record<string, unknown>;

    const sessionResponse = await fetch(url("/_session"), {
      headers: { Authorization: account.authorization, Accept: "application/json" },
    });
    if (sessionResponse.ok) {
      const session = (await sessionResponse.json()) as {
        name?: string | null;
        userCtx?: { name?: string | null };
      };
      if ((session.userCtx?.name ?? session.name) === account.user) {
        console.log(`  account '${account.user}' exists and its password is current`);
        return;
      }
    }
  }

  const roles = Array.isArray(existing?.roles) ? existing.roles : [];
  const document: Record<string, unknown> = {
    _id: documentId,
    name: account.user,
    password: account.password,
    roles,
    type: "user",
  };
  if (typeof existing?._rev === "string") document._rev = existing._rev;

  await adminRequest(path, { method: "PUT", body: JSON.stringify(document) });
  console.log(`  account '${account.user}' created or updated`);
}

async function grantDatabaseAdmin(account: LiveSyncAccount): Promise<void> {
  const path = `/${encodeURIComponent(account.database)}/_security`;
  const { body } = await adminRequest(path);
  const updated = mergeSecurity(JSON.parse(body) as SecurityObject, account.user);
  await adminRequest(path, { method: "PUT", body: JSON.stringify(updated) });
}

async function verifyLiveSyncAccess(account: LiveSyncAccount): Promise<void> {
  const response = await fetch(url(`/${encodeURIComponent(account.database)}`), {
    headers: { Authorization: account.authorization, Accept: "application/json" },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Access check for '${account.user}' on '${account.database}' failed with HTTP ${response.status}: ${body}`,
    );
  }
}

async function main(): Promise<void> {
  config = readConfig();

  console.log("Waiting for CouchDB...");
  await waitForCouchDB();

  console.log("Configuring CouchDB single-node mode...");
  await configureSingleNode();

  console.log("Applying authentication, CORS, and size limits...");
  await configureServer();

  // Sequential, and fatal on the first failure: provisioning is idempotent, so
  // the bounded restart finishes what a transient error interrupted, and a
  // half-configured deployment must not report success.
  for (const account of config.accounts) {
    console.log(`Provisioning '${account.user}' -> '${account.database}'...`);
    await createDatabase(account);
    await initialiseLiveSyncDatabaseVersion(account);
    await upsertLiveSyncUser(account);
    await grantDatabaseAdmin(account);
    await verifyLiveSyncAccess(account);
  }

  console.log("CouchDB provisioning completed successfully.");
  console.log("Configure each Obsidian client with its own username and database:");
  for (const account of config.accounts) {
    console.log(`  ${account.user} -> ${account.database}`);
  }
}

// Guarded so the test module can import the pure helpers above without
// reading the environment or contacting a server.
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    Deno.exit(1);
  }
}
