/**
 * Unit checks for the pure helpers in couchdb-init.ts.
 *
 * Scope ceiling: these cover argument handling and the security-object
 * computation only. The provisioning sequence itself — and its idempotence
 * across a second run — is covered by the integration check in
 * scripts/validate.sh, which needs a live CouchDB and cannot run here.
 *
 * Run with: deno test scripts/couchdb-init.test.ts
 */

import {
  basicAuth,
  databaseFor,
  mergeSecurity,
  normaliseBaseUrl,
  parseAccounts,
  passwordVariableFor,
  validateDatabaseName,
  validateUserName,
} from "./couchdb-init.ts";

/**
 * Local assertions rather than jsr:@std/assert.
 *
 * The provisioning script deliberately has no remote dependencies, which is
 * what makes `deno run --cached-only` meaningful and lets the repository do
 * without a lockfile. A test-only import would put that back for the sake of
 * two functions.
 */
function assertEquals(actual: unknown, expected: unknown): void {
  const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

function assertThrows(fn: () => unknown, includes: string): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(includes)) {
      throw new Error(`expected an error mentioning "${includes}", got: ${message}`);
    }
    return;
  }
  throw new Error(`expected a throw mentioning "${includes}", but nothing was thrown`);
}

Deno.test("mergeSecurity never produces an empty members block", () => {
  // An empty members block means "every authenticated user" in CouchDB.
  // This is the exact input that granted every account full access to the
  // vault: a database whose _security was empty, e.g. restored or replicated
  // in rather than created by this stack.
  const result = mergeSecurity({}, "livesync");

  assertEquals(result.admins?.names, ["livesync"]);
  assertEquals(result.members?.names, ["livesync"]);
  assertEquals(result.members?.roles, ["_admin"]);
});

Deno.test("mergeSecurity keeps the admin_only roles CouchDB seeds", () => {
  const seeded = {
    admins: { names: [] as string[], roles: ["_admin"] },
    members: { names: [] as string[], roles: ["_admin"] },
  };

  const result = mergeSecurity(seeded, "livesync");

  assertEquals(result.admins?.names, ["livesync"]);
  assertEquals(result.admins?.roles, ["_admin"]);
  assertEquals(result.members?.roles, ["_admin"]);
});

Deno.test("mergeSecurity is idempotent and preserves unrelated members", () => {
  const first = mergeSecurity({ members: { names: ["someone"], roles: ["reader"] } }, "livesync");
  const second = mergeSecurity(first, "livesync");

  assertEquals(second, first);
  assertEquals(second.members?.names, ["someone", "livesync"]);
  assertEquals(second.members?.roles, ["reader"]);
});

Deno.test("basicAuth encodes the credential as UTF-8, not Latin-1", () => {
  const expected = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

  // Raw btoa() would yield "cGFzc3f2cmQ=" here — Latin-1 bytes CouchDB will
  // not match, surfacing as a 401 that reads as a wrong password.
  assertEquals(basicAuth("u", "passwörd"), `Basic ${expected("u:passwörd")}`);

  // Raw btoa() throws InvalidCharacterError above U+00FF.
  assertEquals(basicAuth("u", "パスワード"), `Basic ${expected("u:パスワード")}`);
});

Deno.test("normaliseBaseUrl strips trailing slashes, query, and fragment", () => {
  assertEquals(normaliseBaseUrl("http://couchdb:5984/"), "http://couchdb:5984");
  assertEquals(normaliseBaseUrl("http://couchdb:5984/base//?a=1#f"), "http://couchdb:5984/base");
});

Deno.test("validateDatabaseName rejects names CouchDB will not accept", () => {
  assertEquals(validateDatabaseName("vault-alice"), "vault-alice");
  for (const bad of ["Vault", "1notes", "notes/../_users", "notes db", ""]) {
    assertThrows(() => validateDatabaseName(bad), "database name");
  }
});

Deno.test("validateUserName rejects characters that would escape the doc id", () => {
  assertEquals(validateUserName("livesync"), "livesync");
  for (const bad of ["live sync", "live/sync", "live:sync", ""]) {
    assertThrows(() => validateUserName(bad), "LIVESYNC_USER");
  }
});

// --- roster parsing -------------------------------------------------------

/** Builds an env lookup over a plain object, so tests need no --allow-env. */
function envOf(vars: Record<string, string>): (name: string) => string | undefined {
  return (name) => vars[name];
}

Deno.test("passwordVariableFor and databaseFor derive names from the username", () => {
  assertEquals(passwordVariableFor("alice"), "LIVESYNC_PASSWORD_ALICE");
  assertEquals(passwordVariableFor("alice.smith"), "LIVESYNC_PASSWORD_ALICE_SMITH");
  assertEquals(passwordVariableFor("bob-jones"), "LIVESYNC_PASSWORD_BOB_JONES");

  // The vault- prefix guarantees CouchDB's "must start with a lower-case
  // letter" rule, so no username can derive an invalid database name.
  assertEquals(databaseFor("alice"), "vault-alice");
  assertEquals(databaseFor("Alice.Smith"), "vault-alice-smith");
  assertEquals(databaseFor("bob_jones"), "vault-bob-jones");
  validateDatabaseName(databaseFor("9"));
});

Deno.test("parseAccounts builds one account per person", () => {
  const accounts = parseAccounts(
    "alice,bob",
    envOf({ LIVESYNC_PASSWORD_ALICE: "alice-pw", LIVESYNC_PASSWORD_BOB: "bob-pw" }),
  );

  assertEquals(accounts.length, 2);
  assertEquals(accounts[0].user, "alice");
  assertEquals(accounts[0].password, "alice-pw");
  assertEquals(accounts[0].database, "vault-alice");
  assertEquals(accounts[1].database, "vault-bob");
});

Deno.test("parseAccounts tolerates whitespace and trailing separators", () => {
  const accounts = parseAccounts(
    " alice , bob ,",
    envOf({ LIVESYNC_PASSWORD_ALICE: "a", LIVESYNC_PASSWORD_BOB: "b" }),
  );
  assertEquals(accounts.map((a) => a.user), ["alice", "bob"]);
});

Deno.test("parseAccounts rejects an empty roster", () => {
  assertThrows(() => parseAccounts("", envOf({})), "LIVESYNC_USERS");
  assertThrows(() => parseAccounts("  , ,", envOf({})), "LIVESYNC_USERS");
});

Deno.test("parseAccounts rejects an invalid username, naming it", () => {
  assertThrows(() => parseAccounts("alice,bad user", envOf({})), "bad user");
});

Deno.test("parseAccounts names the exact missing password variable", () => {
  assertThrows(
    () => parseAccounts("alice,carol", envOf({ LIVESYNC_PASSWORD_ALICE: "a" })),
    "LIVESYNC_PASSWORD_CAROL",
  );
  // Present but blank is the same failure as absent.
  assertThrows(
    () => parseAccounts("alice", envOf({ LIVESYNC_PASSWORD_ALICE: "   " })),
    "LIVESYNC_PASSWORD_ALICE",
  );
});

Deno.test("parseAccounts rejects names that collide after normalisation", () => {
  // "Alice" and "alice" derive the same database AND the same password
  // variable. Silently merging them would give two people one vault.
  assertThrows(
    () =>
      parseAccounts(
        "Alice,alice",
        envOf({ LIVESYNC_PASSWORD_ALICE: "a" }),
      ),
    "vault-alice",
  );
  assertThrows(
    () =>
      parseAccounts(
        "alice.smith,alice_smith",
        envOf({ LIVESYNC_PASSWORD_ALICE_SMITH: "a" }),
      ),
    "vault-alice-smith",
  );
});

Deno.test("parseAccounts reports every roster problem in one message", () => {
  // Adding three people at once is exactly when several mistakes are in
  // flight; one deploy cycle should surface all of them, not the first.
  let message = "";
  try {
    parseAccounts("alice,bad user,carol", envOf({}));
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assertEquals(message.includes("LIVESYNC_PASSWORD_ALICE"), true);
  assertEquals(message.includes("bad user"), true);
  assertEquals(message.includes("LIVESYNC_PASSWORD_CAROL"), true);
  // The rejected name must not also generate password noise for itself.
  assertEquals(message.includes("LIVESYNC_PASSWORD_BAD_USER"), false);
});
