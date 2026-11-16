import assert from "node:assert/strict";
import test from "node:test";
import {
  addSourceToProject,
  categoryScaffold,
  slugify,
  validateRegistration,
} from "../src/validation.mjs";
import { registerCategory, registerSource } from "../src/operations.mjs";
import { SenderApi } from "../src/sender.mjs";

test("slugify generates a stable lowercase snake_case ID", () => {
  assert.equal(slugify("  DévOps / Cloud  "), "devops_cloud");
  assert.equal(slugify(""), "");
});

test("registrations reject invalid and reserved IDs", () => {
  assert.throws(() => validateRegistration({ id: "Upwork", name: "Upwork" }), {
    message: /lowercase snake_case/,
  });
  assert.throws(() => validateRegistration({ id: "done", name: "Done" }), {
    message: /reserved/,
  });
});

test("adding a source preserves config and records the canonical ID", () => {
  const original = JSON.stringify({
    unrelated: { keep: true },
    sources: [{ id: "linkedin", display_name: "LinkedIn", aliases: ["linkedin"] }],
  });
  const updated = addSourceToProject(original, {
    id: "upwork",
    name: "Upwork",
  });

  assert.equal(updated.changed, true);
  const project = JSON.parse(updated.text);
  assert.deepEqual(project.unrelated, { keep: true });
  assert.deepEqual(project.sources.at(-1), {
    id: "upwork",
    display_name: "Upwork",
    aliases: ["upwork"],
  });
});

test("adding the same source is idempotent and conflicting names fail", () => {
  const original = JSON.stringify({
    sources: [{ id: "upwork", display_name: "Upwork", aliases: ["upwork"] }],
  });
  assert.equal(
    addSourceToProject(original, { id: "upwork", name: "Upwork" }).changed,
    false,
  );
  assert.throws(
    () => addSourceToProject(original, { id: "upwork", name: "Other" }),
    { message: /different name/ },
  );
});

test("category scaffold creates the profile and all standard prompt/keyword modules", () => {
  const files = categoryScaffold({ id: "devops", name: "DevOps" });
  assert.deepEqual(Object.keys(files).sort(), [
    "__init__.py",
    "guard_prompt.py",
    "keywords.py",
    "llm_prompt.py",
    "profile.py",
  ]);
  assert.match(files["profile.py"], /id="devops"/);
  assert.match(
    files["profile.py"],
    /guard_prompt_module="app\.domain\.categories\.devops\.guard_prompt"/,
  );
  assert.match(files["keywords.py"], /POSITIVE_KEYWORDS = \{\}/);
  assert.match(files["llm_prompt.py"], /SYSTEM_PROMPT/);
  assert.match(files["guard_prompt.py"], /SYSTEM_PROMPT/);
});

test("source registration calls the sender before committing to GitHub", async () => {
  const order = [];
  const sender = {
    async ensure(kind, source) {
      order.push(["sender", kind, source.id]);
      return { created: true };
    },
  };
  const github = {
    async readProjectConfig() {
      return {
        baseSha: "base-sha",
        text: JSON.stringify({ sources: [] }),
      };
    },
    async commitFiles(baseSha, files, message) {
      order.push(["github", baseSha, files[0].path, message]);
      return { sha: "new-sha", url: "https://github.com/example/repo/commit/new-sha" };
    },
  };

  const result = await registerSource(
    { id: "upwork", name: "Upwork" },
    { sender, github },
  );

  assert.equal(result.senderCreated, true);
  assert.equal(result.commit.sha, "new-sha");
  assert.deepEqual(order.map((entry) => entry[0]), ["sender", "github"]);
});

test("category registration sends the scaffold in one GitHub commit", async () => {
  const order = [];
  const sender = {
    async ensure(kind, category) {
      order.push(["sender", kind, category.id]);
      return { created: true };
    },
  };
  const github = {
    async readFiles(paths) {
      return {
        baseSha: "base-sha",
        files: paths.map((path) => ({ path, exists: false })),
      };
    },
    async commitFiles(baseSha, files, message) {
      order.push(["github", baseSha, files.length, message]);
      return { sha: "new-sha", url: "https://github.com/example/repo/commit/new-sha" };
    },
  };

  const result = await registerCategory(
    { id: "devops", name: "DevOps" },
    { sender, github },
  );

  assert.equal(result.senderCreated, true);
  assert.equal(order[0][0], "sender");
  assert.deepEqual(order[1], [
    "github",
    "base-sha",
    5,
    "Scaffold category devops",
  ]);
});

test("category registration recognizes an already committed identical scaffold", async () => {
  const scaffold = categoryScaffold({ id: "devops", name: "DevOps" });
  let commits = 0;
  const sender = {
    async ensure() {
      return { created: false };
    },
  };
  const github = {
    async readFiles(paths) {
      return {
        baseSha: "base-sha",
        files: paths.map((path) => {
          const fileName = path.slice(path.lastIndexOf("/") + 1);
          return { path, exists: true, content: scaffold[fileName] };
        }),
      };
    },
    async commitFiles() {
      commits += 1;
    },
  };

  const result = await registerCategory(
    { id: "devops", name: "DevOps" },
    { sender, github },
  );

  assert.equal(result.commit, null);
  assert.equal(commits, 0);
});

test("sender API retries a registration race idempotently", async () => {
  let calls = 0;
  const api = new SenderApi({
    baseUrl: "http://sender.internal:3000",
    fetchImpl: async (url, options) => {
      calls += 1;
      if (options.method === "GET") {
        const records = calls === 1 ? [] : [{ id: "upwork", name: "Upwork" }];
        return new Response(JSON.stringify(records), { status: 200 });
      }
      return new Response('{"message":"already exists"}', { status: 409 });
    },
  });

  const result = await api.ensure("sources", { id: "upwork", name: "Upwork" });

  assert.deepEqual(result, { created: false });
  assert.equal(calls, 3);
});

test("sender API uses its configured base URL and exact registration payload", async () => {
  const calls = [];
  const api = new SenderApi({
    baseUrl: "http://sender.internal:3000",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (options.method === "GET") {
        return new Response("[]", { status: 200 });
      }
      return new Response('{"id":"upwork","name":"Upwork","enabled":true}', {
        status: 201,
      });
    },
  });

  const result = await api.ensure("sources", { id: "upwork", name: "Upwork" });

  assert.equal(result.created, true);
  assert.equal(calls[0].url, "http://sender.internal:3000/sources");
  assert.equal(calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    id: "upwork",
    name: "Upwork",
  });
});
