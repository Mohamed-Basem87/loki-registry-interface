import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { GitHubAppClient } from "../src/github.mjs";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

function testConfig(privateKey) {
  return {
    appId: "123",
    installationId: "456",
    privateKey,
    owner: "owner",
    repo: "repo",
    branch: "main",
  };
}

test("GitHub App client reads the configured project file at a branch commit", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/access_tokens")) {
      return jsonResponse({
        token: "installation-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    }
    if (String(url).endsWith("/git/ref/heads/main")) {
      return jsonResponse({ object: { sha: "base-sha" } });
    }
    if (String(url).includes("/contents/config/project.json")) {
      return jsonResponse({
        type: "file",
        encoding: "base64",
        content: Buffer.from('{"sources":[]}').toString("base64"),
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const github = new GitHubAppClient(testConfig(privateKey), fetchImpl);

  const result = await github.readProjectConfig();

  assert.equal(result.baseSha, "base-sha");
  assert.equal(result.text, '{"sources":[]}');
  assert.equal(calls.length, 3);
  assert.equal(
    calls[1].options.headers.Authorization,
    "Bearer installation-token",
  );
});

test("GitHub App client creates one commit and advances the branch without force", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsedUrl = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: parsedUrl, options, body });

    if (parsedUrl.pathname.endsWith("/access_tokens")) {
      return jsonResponse({
        token: "installation-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    }
    if (parsedUrl.pathname.endsWith("/git/commits/base-sha")) {
      return jsonResponse({ tree: { sha: "base-tree" } });
    }
    if (parsedUrl.pathname.endsWith("/git/blobs")) {
      return jsonResponse({ sha: `blob-${body.content.length}` });
    }
    if (parsedUrl.pathname.endsWith("/git/trees")) {
      return jsonResponse({ sha: "tree-sha" });
    }
    if (parsedUrl.pathname.endsWith("/git/commits")) {
      return jsonResponse({
        sha: "commit-sha",
        html_url: "https://github.com/owner/repo/commit/commit-sha",
      });
    }
    if (parsedUrl.pathname.endsWith("/git/refs/heads/main")) {
      return jsonResponse({ ref: "refs/heads/main" });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const github = new GitHubAppClient(testConfig(privateKey), fetchImpl);

  const result = await github.commitFiles(
    "base-sha",
    [
      { path: "config/project.json", content: '{"sources":[]}\n' },
      { path: "app/domain/categories/devops/profile.py", content: "PROFILE = None\n" },
    ],
    "Test registry commit",
  );

  assert.equal(result.sha, "commit-sha");
  const treeCall = calls.find((call) => call.url.pathname.endsWith("/git/trees"));
  assert.equal(treeCall.body.base_tree, "base-tree");
  assert.equal(treeCall.body.tree.length, 2);

  const updateCall = calls.find((call) =>
    call.url.pathname.endsWith("/git/refs/heads/main"),
  );
  assert.deepEqual(updateCall.body, { sha: "commit-sha", force: false });
});
