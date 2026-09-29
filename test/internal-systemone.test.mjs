import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { configuredOrigin, dispatchInternalSystemOne } = require("../src/internal-systemone.cjs");

test("internal System One dispatch defaults to the HTTP listener origin", async () => {
  const requests = [];
  const response = await dispatchInternalSystemOne({
    body: { state: "sanitized" }, model: "openrouter/typesafe/jev-1.13", authorization: "Bearer client-key",
    env: { PORT: "20128" },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(JSON.stringify({ answers: {} }), { status: 200 });
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(requests.map(({ url }) => url), ["http://127.0.0.1:20128/api/v1/systemone"]);
  assert.equal(requests[0].options.headers.Authorization, "Bearer client-key");
  assert.deepEqual(JSON.parse(requests[0].options.body), { state: "sanitized", model: "openrouter/typesafe/jev-1.13" });
});

test("internal System One dispatch accepts a deployment-specific internal origin", async () => {
  assert.equal(configuredOrigin({ NINE_ROUTER_INTERNAL_ORIGIN: "http://9router:20128/base/ignored" }), "http://9router:20128");
  assert.equal(configuredOrigin({ PORT: "3010" }), "http://127.0.0.1:3010");
  assert.equal(configuredOrigin({ NINE_ROUTER_INTERNAL_ORIGIN: "  ", PORT: "3010" }), "http://127.0.0.1:3010");
});

test("internal System One dispatch rejects malformed and unsupported explicit origins", async () => {
  for (const origin of ["not a URL", "ftp://9router:20128"]) {
    assert.throws(() => configuredOrigin({ NINE_ROUTER_INTERNAL_ORIGIN: origin, PORT: "3010" }), (error) => error.message === "systemone-invalid-origin");
  }
  await assert.rejects(
    dispatchInternalSystemOne({ env: { NINE_ROUTER_INTERNAL_ORIGIN: "ftp://9router:20128" }, fetchImpl: async () => new Response() }),
    (error) => error.message === "systemone-invalid-origin",
  );
});

test("internal System One dispatch reports sanitized network and HTTP failures", async () => {
  await assert.rejects(
    dispatchInternalSystemOne({ fetchImpl: async () => { throw new Error("TLS wrong version secret-token"); } }),
    (error) => error.message === "systemone-network",
  );
  await assert.rejects(
    dispatchInternalSystemOne({ fetchImpl: async () => new Response("provider response secret", { status: 502 }) }),
    (error) => error.message === "systemone-http-502",
  );
});
