"use strict";

const DEFAULT_PORT = 20128;
const INTERNAL_ORIGIN_ENV = "NINE_ROUTER_INTERNAL_ORIGIN";

function configuredOrigin(env = process.env) {
  const explicit = typeof env?.[INTERNAL_ORIGIN_ENV] === "string" ? env[INTERNAL_ORIGIN_ENV].trim() : "";
  if (explicit) {
    let url;
    try {
      url = new URL(explicit);
    } catch {
      throw dispatchError("systemone-invalid-origin");
    }
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    throw dispatchError("systemone-invalid-origin");
  }
  const port = Number(env?.PORT);
  return `http://127.0.0.1:${Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT}`;
}

function dispatchError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function dispatchInternalSystemOne({ body, model, authorization, signal, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const url = new URL("/api/v1/systemone", configuredOrigin(env));
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
      body: JSON.stringify({ ...body, model }),
      signal,
    });
  } catch {
    throw dispatchError("systemone-network");
  }
  if (!response?.ok) {
    const status = Number(response?.status);
    throw dispatchError(`systemone-http-${Number.isInteger(status) && status >= 100 && status <= 599 ? status : "unknown"}`);
  }
  return response;
}

module.exports = { DEFAULT_PORT, INTERNAL_ORIGIN_ENV, configuredOrigin, dispatchInternalSystemOne };
