import { readFileSync } from "node:fs";
import { RequestError } from "./validation.mjs";

function secret(env, name, fileName) {
  const filePath = env[fileName];
  if (filePath) {
    try {
      return readFileSync(filePath, "utf8").replace(/[\r\n]+$/, "");
    } catch {
      throw new Error(`${fileName} points to a file that cannot be read.`);
    }
  }
  return String(env[name] || "").replace(/\\n/g, "\n");
}

function booleanValue(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

export function loadConfig(env = process.env) {
  const adminUsername = String(env.ADMIN_USERNAME || "").trim();
  const adminPassword = secret(env, "ADMIN_PASSWORD", "ADMIN_PASSWORD_FILE");
  const sessionSecret = secret(env, "SESSION_SECRET", "SESSION_SECRET_FILE");
  const port = Number(env.PORT || 8080);

  if (!adminUsername || !adminPassword) {
    throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD(_FILE) are required.");
  }
  if (Buffer.byteLength(sessionSecret) < 32) {
    throw new Error("SESSION_SECRET(_FILE) must contain at least 32 bytes.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535.");
  }

  const senderBaseUrl = String(env.SENDER_API_BASE_URL || "").trim();
  if (senderBaseUrl) {
    try {
      const url = new URL(senderBaseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("invalid sender URL");
      }
    } catch {
      throw new Error("SENDER_API_BASE_URL must be a valid HTTP(S) URL.");
    }
  }

  const githubPrivateKey = secret(
    env,
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_PRIVATE_KEY_FILE",
  );

  return {
    adminUsername,
    adminPassword,
    sessionSecret,
    port,
    cookieSecure: booleanValue(env.COOKIE_SECURE, false),
    github: {
      appId: String(env.GITHUB_APP_ID || "").trim(),
      installationId: String(env.GITHUB_APP_INSTALLATION_ID || "").trim(),
      privateKey: githubPrivateKey,
      owner: String(env.GITHUB_OWNER || "").trim(),
      repo: String(env.GITHUB_REPO || "").trim(),
      branch: String(env.GITHUB_BRANCH || "main").trim(),
    },
    senderBaseUrl,
    senderToken: String(env.SENDER_API_TOKEN || "").trim(),
  };
}

export function assertOperationConfigured(config, github, sender) {
  if (!github.isConfigured()) {
    throw new RequestError("GitHub App configuration is incomplete.", 503);
  }
  if (!sender.isConfigured()) {
    throw new RequestError("SENDER_API_BASE_URL is not configured.", 503);
  }
  if (!config.github.branch) {
    throw new RequestError("GITHUB_BRANCH is not configured.", 503);
  }
}
