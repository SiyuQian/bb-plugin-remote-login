import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { HTTPResponse, Page } from "puppeteer-core";
import { createConsoleSourceAttestor, type ConsoleSourceProof } from "../oci-console-source.ts";
import { consoleSourcePins } from "../oci-console-protocol.ts";

function fixture(digest?: (bytes: Buffer) => string) {
  const frame = {}, target = {}, context = {}, browser = { connected: true }, events = new EventEmitter();
  const page = Object.assign(events, { url: () => "https://cloud.oracle.com/", isClosed: () => false, mainFrame: () => frame, target: () => target, browserContext: () => context, browser: () => browser }) as unknown as Page;
  const lifecycle = new AbortController(), boundary = createConsoleSourceAttestor(page, lifecycle.signal, digest ? { digest } : undefined);
  let buffers = 0;
  const deliver = (patch: Record<string, unknown> = {}, requestPatch: Record<string, unknown> = {}) => {
    const request = { frame: () => frame, resourceType: () => "script", redirectChain: () => [], ...requestPatch };
    const response = { request: () => request, url: () => consoleSourcePins[0]!.url, status: () => 200, fromCache: () => false, fromServiceWorker: () => false,
      headers: () => ({ "content-type": "application/javascript" }), buffer: async () => { buffers++; return Buffer.from("changed public source fixture"); }, ...patch } as unknown as HTTPResponse;
    events.emit("response", response);
  };
  return { boundary, lifecycle, deliver, buffers: () => buffers };
}

test("source proofs cannot be supplied as caller objects and missing deliveries cannot attest a Console page", async () => {
  const f = fixture();
  try {
    assert.throws(() => f.boundary.assert({} as ConsoleSourceProof));
    await assert.rejects(f.boundary.capture(f.lifecycle.signal), { message: "Console source attestation unavailable." });
  } finally { f.boundary.dispose(); f.lifecycle.abort(); }
});

test("actual source digest mismatch fails closed without producing an opaque attestation", async () => {
  const f = fixture();
  try {
    f.deliver();
    await assert.rejects(f.boundary.capture(f.lifecycle.signal));
    assert.equal(f.buffers(), 1);
  } finally { f.boundary.dispose(); f.lifecycle.abort(); }
});

test("foreign frame, cached, redirected, non-script and incompatible-build source deliveries cannot be used", async (t) => {
  for (const kind of ["frame", "cache", "service-worker", "redirect", "mime", "version"] as const) await t.test(kind, async () => {
    const f = fixture();
    try {
      if (kind === "frame") f.deliver({}, { frame: () => ({}) });
      if (kind === "cache") f.deliver({ fromCache: () => true });
      if (kind === "service-worker") f.deliver({ fromServiceWorker: () => true });
      if (kind === "redirect") f.deliver({}, { redirectChain: () => [{}] });
      if (kind === "mime") f.deliver({ headers: () => ({ "content-type": "application/json" }) });
      if (kind === "version") f.deliver({ url: () => consoleSourcePins[0]!.url.replace("4.26.2hotfix.2", "unknown-build") });
      await assert.rejects(f.boundary.capture(f.lifecycle.signal));
      assert.equal(f.buffers(), 0);
    } finally { f.boundary.dispose(); f.lifecycle.abort(); }
  });
});

// Fixture-only digest boundary avoids vendoring Oracle's bundles. The default real SHA path is tested separately.
function completeSourceFixture() {
  const f = fixture((bytes) => consoleSourcePins[Number(bytes.toString())]!.sha256);
  for (const [index, pin] of consoleSourcePins.entries()) f.deliver({ url: () => pin.url, buffer: async () => Buffer.from(String(index)) });
  return f;
}

test("every new critical delivery synchronously revokes old proofs while its bytes are still pending", async () => {
  const f = completeSourceFixture();
  let release!: (bytes: Buffer) => void;
  const held = new Promise<Buffer>((resolve) => { release = resolve; });
  try {
    const before = await f.boundary.capture(f.lifecycle.signal); f.boundary.assert(before);
    f.deliver({ buffer: () => held });
    assert.throws(() => f.boundary.assert(before));
    release(Buffer.from("0"));
    const after = await f.boundary.capture(f.lifecycle.signal);
    f.boundary.assert(after);
    assert.throws(() => f.boundary.assert(before), "matching bytes must not revive an earlier proof");
  } finally { release?.(Buffer.from("0")); f.boundary.dispose(); f.lifecycle.abort(); }
});

test("a critical delivery beginning during capture cannot be omitted from its attestation revision", async () => {
  const f = completeSourceFixture();
  let release!: (bytes: Buffer) => void;
  const held = new Promise<Buffer>((resolve) => { release = resolve; });
  try {
    await f.boundary.capture(f.lifecycle.signal);
    const pending = f.boundary.capture(f.lifecycle.signal);
    f.deliver({ buffer: () => held });
    await assert.rejects(pending);
  } finally { release?.(Buffer.from("0")); f.boundary.dispose(); f.lifecycle.abort(); }
});
