import { RequestError } from "./validation.mjs";

export class SenderApi {
  constructor({ baseUrl, token = "", fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.baseUrl);
  }

  async list(kind) {
    this.#assertConfigured();
    const result = await this.#request("GET", kind);
    if (!Array.isArray(result)) {
      throw new RequestError(
        `Sender GET /${kind} returned an unexpected response.`,
        502,
      );
    }
    return result;
  }

  async ensure(kind, { id, name }) {
    const records = await this.list(kind);
    const matching = this.#findMatchingRecord(records, kind, { id, name });
    if (matching) return { created: false };

    try {
      await this.#request("POST", kind, { id, name });
      return { created: true };
    } catch (error) {
      if (error.statusCode !== 409) throw error;

      const currentRecords = await this.list(kind);
      if (this.#findMatchingRecord(currentRecords, kind, { id, name })) {
        return { created: false };
      }
      throw error;
    }
  }

  #findMatchingRecord(records, kind, { id, name }) {
    const label = kind === "categories" ? "category" : "source";
    const existing = records.find((item) => item.id === id);
    if (existing) {
      if (existing.name !== name) {
        throw new RequestError(
          `Sender already has ${label} ID "${id}" with a different name.`,
          409,
        );
      }
      return existing;
    }

    if (records.some((item) => item.name === name)) {
      throw new RequestError(
        `Sender already has a ${label} with the name "${name}" under another ID.`,
        409,
      );
    }
    return null;
  }

  #assertConfigured() {
    if (!this.baseUrl) {
      throw new RequestError("SENDER_API_BASE_URL is not configured.", 503);
    }
  }

  async #request(method, endpoint, body) {
    this.#assertConfigured();

    let url;
    try {
      const base = new URL(this.baseUrl);
      if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
        throw new Error("unsupported URL");
      }
      base.pathname = `${base.pathname.replace(/\/+$/, "")}/${endpoint}`;
      base.search = "";
      base.hash = "";
      url = base;
    } catch {
      throw new RequestError("SENDER_API_BASE_URL must be a valid HTTP(S) URL.", 503);
    }

    const headers = { Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      throw new RequestError(
        `Could not reach the sender API (${error.name === "TimeoutError" ? "request timed out" : "network error"}).`,
        502,
      );
    }

    const text = await response.text();
    let result = null;
    if (text) {
      try {
        result = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new RequestError("Sender API returned invalid JSON.", 502);
        }
      }
    }
    if (!response.ok) {
      const message =
        typeof result?.message === "string"
          ? result.message
          : `Sender API returned HTTP ${response.status}.`;
      throw new RequestError(message, response.status === 409 ? 409 : 502);
    }
    return result;
  }
}
