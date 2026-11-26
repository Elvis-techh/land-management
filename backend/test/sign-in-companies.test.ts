import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildApp } from "../src/app.js";
import { SESSION_COOKIE, createSession } from "../src/auth/session.js";
import { createCompany, openAccounts } from "../src/db/accounts.js";
import type { Company } from "../src/db/companies.js";
import { companyRegistry } from "../src/db/companies.js";
import { projects, users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";
import { testConfig } from "./helpers.js";

/**
 * Signing in opens the signed-in person's company, and no other.
 *
 * docs/later-versions.md, section 1: one database file per company, and a
 * small accounts database that says which company each email belongs to.
 * Everything here runs on real files in a temporary folder, through the same
 * registry the server uses.
 */

const PASSWORD = "una-contraseña-larga";

async function addOwner(company: Company, email: string) {
  const id = randomUUID();
  company.db
    .insert(users)
    .values({
      id,
      email,
      name: `Supervisor ${company.id}`,
      role: "owner",
      passwordHash: await hashPassword(PASSWORD),
    })
    .run();
  return id;
}

async function twoCompaniesOnDisk(options: { now?: () => number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lindero-sign-in-"));
  const config = {
    ...testConfig,
    databasePath: join(root, "lindero.db"),
    uploadsPath: join(root, "uploads"),
    companiesPath: join(root, "companies"),
    accountsPath: join(root, "accounts.db"),
  };

  const accounts = openAccounts(config.accountsPath);
  const opened: string[] = [];
  const companies = companyRegistry(config, accounts.db, {
    now: options.now,
    onOpen: (company) => opened.push(company.id),
  });

  const one = companies.get("1")!;
  await addOwner(one, "owner@empresa1.hn");
  one.db.insert(projects).values({ id: randomUUID(), name: "Proyecto de la empresa 1" }).run();
  companies.usersChanged(one);

  const twoId = createCompany(accounts.db);
  const two = companies.get(twoId)!;
  const ownerTwo = await addOwner(two, "owner@empresa2.hn");
  two.db.insert(projects).values({ id: randomUUID(), name: "Proyecto de la empresa 2" }).run();
  companies.usersChanged(two);

  const app = await buildApp(config, companies);
  await app.ready();

  const close = async () => {
    await app.close();
    companies.closeAll();
    accounts.sqlite.close();
  };

  return { root, config, accounts, companies, app, one, two, ownerTwo, opened, close };
}

type Setup = Awaited<ReturnType<typeof twoCompaniesOnDisk>>;

async function signIn(app: Setup["app"], email: string, password = PASSWORD) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
  const cookie = response.cookies.find((entry) => entry.name === SESSION_COOKIE);
  return { response, value: cookie?.value ?? null };
}

async function projectNames(app: Setup["app"], cookieValue: string) {
  const response = await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: { cookie: `${SESSION_COOKIE}=${cookieValue}` },
  });
  const names =
    response.statusCode === 200
      ? response.json().projects.map((project: { name: string }) => project.name)
      : [];
  return { status: response.statusCode, names };
}

describe("signing in to a company", () => {
  it("opens the company the email belongs to, and shows only its records", async () => {
    const setup = await twoCompaniesOnDisk();

    const one = await signIn(setup.app, "owner@empresa1.hn");
    const two = await signIn(setup.app, "OWNER@empresa2.hn");
    assert.equal(one.response.statusCode, 200, one.response.body);
    assert.equal(two.response.statusCode, 200, two.response.body);
    assert.match(one.value!, /^1\./);
    assert.match(two.value!, /^2\./);

    assert.deepEqual(await projectNames(setup.app, one.value!), {
      status: 200,
      names: ["Proyecto de la empresa 1"],
    });
    assert.deepEqual(await projectNames(setup.app, two.value!), {
      status: 200,
      names: ["Proyecto de la empresa 2"],
    });

    await setup.close();
  });

  it("finds nobody when the company in the cookie is changed", async () => {
    const setup = await twoCompaniesOnDisk();
    const one = await signIn(setup.app, "owner@empresa1.hn");

    const forged = one.value!.replace(/^1\./, "2.");
    assert.equal((await projectNames(setup.app, forged)).status, 401);

    const me = await setup.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `${SESSION_COOKIE}=${forged}` },
    });
    assert.equal(me.statusCode, 401);

    await setup.close();
  });

  it("never opens or creates a file for a company that does not exist", async () => {
    const setup = await twoCompaniesOnDisk();
    const one = await signIn(setup.app, "owner@empresa1.hn");

    for (const id of ["99", "0", "01", "x"]) {
      const forged = one.value!.replace(/^1\./, `${id}.`);
      assert.equal((await projectNames(setup.app, forged)).status, 401, id);
    }
    assert.ok(!existsSync(join(setup.config.companiesPath, "99")));
    assert.equal(setup.companies.get("99"), null);

    await setup.close();
  });

  it("keeps a session from before there were several companies, as company 1's", async () => {
    const setup = await twoCompaniesOnDisk();
    const owner = setup.one.db.select().from(users).get()!;

    const bareToken = createSession(setup.one.db, owner.id, 7);
    assert.deepEqual(await projectNames(setup.app, bareToken), {
      status: 200,
      names: ["Proyecto de la empresa 1"],
    });

    await setup.close();
  });

  it("refuses an email no company has exactly like a wrong password", async () => {
    const setup = await twoCompaniesOnDisk();

    const unknown = await signIn(setup.app, "nadie@ningunlado.hn");
    const wrong = await signIn(setup.app, "owner@empresa2.hn", "otra-contraseña-larga");

    assert.equal(unknown.response.statusCode, 401);
    assert.equal(wrong.response.statusCode, 401);
    assert.deepEqual(unknown.response.json(), wrong.response.json());

    await setup.close();
  });

  it("signs out of the company the session is in", async () => {
    const setup = await twoCompaniesOnDisk();
    const two = await signIn(setup.app, "owner@empresa2.hn");
    const cookie = `${SESSION_COOKIE}=${two.value}`;

    const out = await setup.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });
    assert.equal(out.statusCode, 200);
    assert.equal((await projectNames(setup.app, two.value!)).status, 401);

    await setup.close();
  });
});

describe("one email, one company", () => {
  const asSupervisor = async (setup: Setup, email: string) => {
    const { value } = await signIn(setup.app, email);
    return { cookie: `${SESSION_COOKIE}=${value}` };
  };

  it("refuses to give someone an email another company signs in with", async () => {
    const setup = await twoCompaniesOnDisk();
    const headers = await asSupervisor(setup, "owner@empresa2.hn");

    const taken = await setup.app.inject({
      method: "POST",
      url: "/api/users",
      headers,
      payload: { name: "Copia", email: "Owner@Empresa1.hn", role: "staff", password: PASSWORD },
    });
    assert.equal(taken.statusCode, 409, taken.body);
    assert.equal(taken.json().error, "email_used_elsewhere");
    assert.match(taken.json().message, /otra empresa/);

    // And through an edit.
    const users2 = await setup.app.inject({ method: "GET", url: "/api/users", headers });
    const ownerTwo = users2.json().users[0];
    const edit = await setup.app.inject({
      method: "PATCH",
      url: `/api/users/${ownerTwo.id}`,
      headers,
      payload: { name: ownerTwo.name, email: "owner@empresa1.hn", role: "owner" },
    });
    assert.equal(edit.statusCode, 409, edit.body);

    await setup.close();
  });

  it("lets a new account sign in to its company, and moves sign-in with a changed email", async () => {
    const setup = await twoCompaniesOnDisk();
    const headers = await asSupervisor(setup, "owner@empresa2.hn");

    const created = await setup.app.inject({
      method: "POST",
      url: "/api/users",
      headers,
      payload: {
        name: "Asociada",
        email: "asociada@empresa2.hn",
        role: "staff",
        password: PASSWORD,
      },
    });
    assert.equal(created.statusCode, 201, created.body);

    const first = await signIn(setup.app, "asociada@empresa2.hn");
    assert.equal(first.response.statusCode, 200, first.response.body);
    assert.match(first.value!, /^2\./);

    const edit = await setup.app.inject({
      method: "PATCH",
      url: `/api/users/${created.json().user.id}`,
      headers,
      payload: { name: "Asociada", email: "nueva@empresa2.hn", role: "staff" },
    });
    assert.equal(edit.statusCode, 200, edit.body);

    assert.equal((await signIn(setup.app, "asociada@empresa2.hn")).response.statusCode, 401);
    assert.equal((await signIn(setup.app, "nueva@empresa2.hn")).response.statusCode, 200);

    await setup.close();
  });

  it("puts a company's emails right when its file is opened", async () => {
    let clock = 0;
    const setup = await twoCompaniesOnDisk({ now: () => clock });

    // Added by a script, behind the accounts database's back.
    const two = setup.companies.get("2")!;
    await addOwner(two, "por-script@empresa2.hn");
    assert.equal((await signIn(setup.app, "por-script@empresa2.hn")).response.statusCode, 401);

    clock += 60 * 60 * 1000;
    assert.deepEqual(setup.companies.closeIdle(), ["2"]);

    // The next time anyone uses the company, its file is opened and its
    // emails copied. (Company 1 is opened at every start, so a script run on
    // it before a restart is covered from the start.)
    assert.equal((await signIn(setup.app, "owner@empresa2.hn")).response.statusCode, 200);

    const late = await signIn(setup.app, "por-script@empresa2.hn");
    assert.equal(late.response.statusCode, 200, late.response.body);

    await setup.close();
  });
});

describe("opening and closing companies", () => {
  it("closes a company nobody has used, never company 1, and opens it again when needed", async () => {
    let clock = 0;
    const setup = await twoCompaniesOnDisk({ now: () => clock });
    const two = await signIn(setup.app, "owner@empresa2.hn");
    assert.deepEqual(setup.opened, ["2"]);

    clock += 10 * 60 * 1000;
    assert.deepEqual(setup.companies.closeIdle(), [], "used ten minutes ago");

    clock += 10 * 60 * 1000;
    assert.deepEqual(setup.companies.closeIdle(), ["2"]);
    assert.deepEqual(
      setup.companies.open().map((company) => company.id),
      ["1"],
    );

    // The same session works: the file is opened again, upgraded and checked.
    assert.deepEqual(await projectNames(setup.app, two.value!), {
      status: 200,
      names: ["Proyecto de la empresa 2"],
    });
    assert.deepEqual(setup.opened, ["2", "2"]);

    await setup.close();
  });
});
