import { createSign } from "node:crypto";
import { RequestError } from "./validation.mjs";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";

function encodeSegment(value) {
  return encodeURIComponent(value);
}

function encodePath(value) {
  return value.split("/").map(encodeSegment).join("/");
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

export class GitHubAppClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.installationToken = "";
    this.installationTokenExpiresAt = 0;
  }

  isConfigured() {
    const c = this.config;
    return Boolean(
      c.appId &&
        c.installationId &&
        c.privateKey &&
        c.owner &&
        c.repo &&
        c.branch,
    );
  }

  async readProjectConfig() {
    const baseSha = await this.#getBranchCommitSha();
    const project = await this.#readTextFile(
      "config/project.json",
      baseSha,
    );
    if (project === null) {
      throw new RequestError(
        "config/project.json was not found on the configured GitHub branch.",
        502,
      );
    }
    return { baseSha, text: project };
  }

  async readFiles(paths) {
    const baseSha = await this.#getBranchCommitSha();
    const files = await Promise.all(
      paths.map(async (path) => ({
        path,
        content: await this.#readTextFile(path, baseSha),
      })),
    );
    return {
      baseSha,
      files: files.map((file) => ({ ...file, exists: file.content !== null })),
    };
  }

  async commitFiles(baseSha, files, message) {
    if (!files.length) {
      throw new RequestError("Refusing to create an empty GitHub commit.");
    }

    const parentCommit = await this.#api(
      `/repos/${encodeSegment(this.config.owner)}/${encodeSegment(this.config.repo)}/git/commits/${encodeSegment(baseSha)}`,
    );
    const blobs = await Promise.all(
      files.map(async ({ path, content }) => {
        const blob = await this.#api(
          `/repos/${encodeSegment(this.config.owner)}/${encodeSegment(this.config.repo)}/git/blobs`,
          {
            method: "POST",
            body: { content, encoding: "utf-8" },
          },
        );
        return {
          path,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        };
      }),
    );

    const tree = await this.#api(
      `/repos/${encodeSegment(this.config.owner)}/${encodeSegment(this.config.repo)}/git/trees`,
      {
        method: "POST",
        body: { base_tree: parentCommit.tree.sha, tree: blobs },
      },
    );
    const commit = await this.#api(
      `/repos/${encodeSegment(this.config.owner)}/${encodeSegment(this.config.repo)}/git/commits`,
      {
        method: "POST",
        body: {
          message,
          tree: tree.sha,
          parents: [baseSha],
        },
      },
    );

    const ref = this.config.branch
      .split("/")
      .map(encodeSegment)
      .join("/");
    await this.#api(
      `/repos/${encodeSegment(this.config.owner)}/${encodeSegment(this.config.repo)}/git/refs/heads/${ref}`,
      {
        method: "PATCH",
        body: { sha: commit.sha, force: false },
      },
    );

    return {
      sha: commit.sha,
      url: commit.html_url,
    };
  }

  async #getBranchCommitSha() {
    const ref = this.config.branch
      .split("/")
      .map(encodeSegment)
      .join("/");
    const result = await this.#api(
      `/repos/${encodeSegment(this.config.owner)}/${encodeSegment(this.config.repo)}/git/ref/heads/${ref}`,
    );
    return result.object.sha;
  }

  async #readTextFile(path, ref) {
    const query = new URLSearchParams({ ref });
    const endpoint = `/repos/${encodeSegment(this.config.owner)}/${encodeSegment(this.config.repo)}/contents/${encodePath(path)}?${query}`;
    let result;
    try {
      result = await this.#api(endpoint);
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }

    if (result.type !== "file" || result.encoding !== "base64") {
      throw new RequestError(`GitHub path "${path}" is not a normal text file.`, 502);
    }
    return Buffer.from(result.content.replace(/\s/g, ""), "base64").toString("utf8");
  }

  async #api(path, options = {}) {
    const token = await this.#getInstallationToken();
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
    };
    if (options.body) headers["Content-Type"] = "application/json";

    let response;
    try {
      response = await this.fetchImpl(`${API_ROOT}${path}`, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw new RequestError(
        `GitHub API request failed (${error.name === "TimeoutError" ? "request timed out" : "network error"}).`,
        502,
      );
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new RequestError("GitHub API returned invalid JSON.", 502);
      }
    }
    if (!response.ok) {
      const message =
        typeof data?.message === "string"
          ? data.message
          : `GitHub API returned HTTP ${response.status}.`;
      throw new RequestError(message, response.status);
    }
    return data;
  }

  async #getInstallationToken() {
    if (!this.isConfigured()) {
      throw new RequestError("GitHub App configuration is incomplete.", 503);
    }
    if (Date.now() < this.installationTokenExpiresAt) {
      return this.installationToken;
    }

    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64Url(
      JSON.stringify({
        iat: now - 60,
        exp: now + 540,
        iss: this.config.appId,
      }),
    );
    const signingInput = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();

    let signature;
    try {
      signature = signer.sign(this.config.privateKey).toString("base64url");
    } catch {
      throw new RequestError("Could not sign a GitHub App authentication token.", 503);
    }

    const endpoint = `/app/installations/${encodeSegment(this.config.installationId)}/access_tokens`;
    let response;
    try {
      response = await this.fetchImpl(`${API_ROOT}${endpoint}`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${signingInput}.${signature}`,
          "X-GitHub-Api-Version": API_VERSION,
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw new RequestError(
        `Could not obtain a GitHub installation token (${error.name === "TimeoutError" ? "request timed out" : "network error"}).`,
        502,
      );
    }

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new RequestError("GitHub token endpoint returned invalid JSON.", 502);
    }
    if (!response.ok || !data.token) {
      throw new RequestError(
        typeof data.message === "string"
          ? data.message
          : `GitHub token endpoint returned HTTP ${response.status}.`,
        response.status || 502,
      );
    }

    const expiresAt = Date.parse(data.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new RequestError("GitHub returned an invalid installation-token expiry.", 502);
    }
    this.installationToken = data.token;
    this.installationTokenExpiresAt = expiresAt - 60 * 1000;
    return this.installationToken;
  }
}
