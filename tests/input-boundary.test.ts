import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

test("private input routes require a canonical operation identity before dispatching to any host", async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login" });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const scope = { threadId: "identity-boundary-thread", attemptId: "identity-boundary-attempt", browserContextId: "identity-boundary-browser", generation: 1 };
  for (const route of ["fixture", "login"] as const) {
    const selection = route === "fixture" ? { hostId: "identity-boundary-host", scope } : { attemptId: scope.attemptId };
    const post = (extra: object) => harness.behavior.fetchHttp("POST", `/${route}/input`, {
      headers: { "content-type": "application/json" }, body: JSON.stringify({ ...selection, frameRef: "11111111-1111-4111-8111-111111111111", event: { type: "text", text: "fabricated boundary input" }, ...extra }),
    });
    assert.equal((await post({})).status, 400, "legacy input without an operation identity must fail closed");
    for (const inputId of ["not-an-id", " " + "11111111-1111-4111-8111-111111111111", "11111111-1111-1111-8111-111111111111"]) {
      assert.equal((await post({ inputId })).status, 400);
    }
    assert.equal((await post({ inputId: "11111111-1111-4111-8111-111111111111" })).status, 401, "operation identity never replaces private authorization");
  }
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 0);
});

test("private input routes reject legacy missing frame references before authority or host dispatch", async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login" });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  for (const route of ["fixture", "login"]) {
    const selection = route === "fixture" ? { hostId: "frame-host", scope: { threadId: "frame-thread", attemptId: "frame-attempt", browserContextId: "frame-browser", generation: 1 } } : { attemptId: "frame-attempt" };
    const value = { ...selection, inputId: "22222222-2222-4222-8222-222222222222", event: { type: "key", key: "Enter" } };
    const response = await harness.behavior.fetchHttp("POST", "/" + route + "/input", { headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    assert.equal(response.status, 400);
  }
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 0);
});
