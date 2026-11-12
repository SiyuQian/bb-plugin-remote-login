import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import fs from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import puppeteer, { ProtocolError, type Browser, type Page } from "puppeteer-core";
import type { ConsoleSourceBoundary, ConsoleSourceProof } from "../oci-console-source.ts";
import { consoleScope, expectedConsole, supportedConsoleFixture } from "./oci-console-fixture.ts";
import type { FixtureInput } from "../fixture-wire.ts";
import type { ConsoleBrowser } from "../oci-console-browser.ts";
import { StaleFrameError } from "../frame-error.ts";

const options = { skip: !supportedConsoleFixture, timeout: 25000, concurrency: false };
async function fixture(t: TestContext, defaults: { realSources?: boolean; delayMetadataMs?: number; controlMode?: "remote" | "host"; refuseInputFence?: boolean } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "owned-console-browser-")); await chmod(root, 0o700);
  await promisify(execFile)("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=loopback-console", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem")]);
  const data = join(root, "private"); await (await import("node:fs/promises")).mkdir(data, { mode: 0o700 });
  const state = { reads: 0, refresh: 0, unrelated: 0, owned: true, sourceValid: true, beforeRead: async () => {}, beforeOther: async () => {}, onPausedPage: () => {} };
  const html = `<!doctype html><title>Console ${expectedConsole.userOcid}</title><h1>Owned Console</h1><h2>${expectedConsole.tenancyOcid}</h2><form><h2>private form heading</h2><input value="fixture-secret"></form><button id="local-effect" onclick="globalThis.localEffects=(globalThis.localEffects||0)+1">Local effect</button><script>
  const identity={sub:${JSON.stringify(expectedConsole.userOcid)},tenant:${JSON.stringify(expectedConsole.tenancyOcid)},domain_ocid:${JSON.stringify(expectedConsole.domainOcid)},domain_stripe_url:${JSON.stringify(expectedConsole.domainOrigin)},nonce:"generation-1"};
  const authenticator={getIdentityToken:async()=>({...identity}),getOverrideTenant:async()=>undefined};
  const signed=async resource=>{if(globalThis.refreshBeforeRead)await fetch(${JSON.stringify(expectedConsole.domainOrigin)}+"/oauth2/v1/token",{method:"POST"});const request=new Request(resource);request.headers.set("Authorization",'Signature keyId="ST$fixture-private",version="1",algorithm="rsa-sha256",signature="fixture"');return fetch(request);};
  class SelfServiceMeApi{constructor(fetch,origin){this.fetch=fetch;this.origin=origin;}async getMe(input,options){const url=new URL("/admin/v1/Me",this.origin);url.searchParams.set("attributes",input.attributes);const response=await this.fetch(new Request(url,{...options,method:"GET",headers:{...options.headers,"Content-Type":input.contentType}}));if(!response.ok)throw Error("refused");return{data:await response.json()};}}
  const Auth={getAuthenticator:()=>authenticator,getFetchApi:()=>signed};globalThis.webpackChunkoci_console={push:([ids,values,callback])=>callback(id=>({30045:{g:Auth},80002:{SelfServiceMeApi}})[id])};
  globalThis.fixtureIdentity=identity;
  </script>`;
  const server = https.createServer({ key: await readFile(join(root,"key.pem")), cert: await readFile(join(root,"cert.pem")) }, async (request,response) => {
    response.setHeader("Access-Control-Allow-Origin", "https://cloud.oracle.com"); response.setHeader("Access-Control-Allow-Headers", "authorization,content-type,opc-request-id,x-date"); response.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS"); response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (request.headers.host?.startsWith("cloud.oracle.com") && request.url === "/?region=ap-sydney-1") { response.writeHead(200,{"content-type":"text/html"}); response.end(html); return; }
    if (request.url?.startsWith("/admin/v1/Me?")) { state.reads++; await state.beforeRead(); if(response.destroyed)return; response.writeHead(200,{"content-type":"application/json"}); response.end(JSON.stringify({active:true,ocid:expectedConsole.userOcid,tenancyOcid:expectedConsole.tenancyOcid,domainOcid:expectedConsole.domainOcid}));return; }
    if (request.url === "/oauth2/v1/token") state.refresh++;
    if (request.url === "/unrelated") { state.unrelated++; await state.beforeOther(); }
    if (!response.destroyed) { response.writeHead(200,{"content-type":"text/plain"}); response.end("fixture response"); }
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); const address=server.address(); if(!address||typeof address==="string")throw Error("fixture unavailable");
  let browser: Browser | undefined; let launchOptions: Parameters<typeof puppeteer.launch>[0];
  let driver: Awaited<ReturnType<typeof import("../oci-console-browser.ts").openOciConsoleBrowser>> | undefined;
  const lifecycle = new AbortController();
  t.after(async()=>{lifecycle.abort();await driver?.close().catch(()=>{});await browser?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
  const launch = async (input: Parameters<typeof puppeteer.launch>[0]) => {
    launchOptions=input;browser=await puppeteer.launch({...input,acceptInsecureCerts:true,args:[...input?.args??[],`--host-resolver-rules=MAP * 127.0.0.1:${address.port}`]});
    const target=browser.target(),create=target.createCDPSession.bind(target);t.mock.method(target,"createCDPSession",async()=>{const session=await create();session.on("Target.attachedToTarget",event=>{if(event.targetInfo.type==="page"&&event.waitingForDebugger)state.onPausedPage();});return session;});
    if(defaults.delayMetadataMs || defaults.refuseInputFence){const createContext=browser.createBrowserContext.bind(browser);t.mock.method(browser,"createBrowserContext",async (settings:Parameters<Browser["createBrowserContext"]>[0])=>{const context=await createContext(settings),newPage=context.newPage.bind(context);t.mock.method(context,"newPage",async()=>{const page=await newPage(),createSession=page.createCDPSession.bind(page);let first=true;t.mock.method(page,"createCDPSession",async()=>{const session=await createSession();if(defaults.refuseInputFence){const send=session.send.bind(session);t.mock.method(session,"send",((method:string,...args:unknown[])=>{if(method==="Input.setIgnoreInputEvents")throw Error("fixture missing fence ACK");return Reflect.apply(send,session,[method,...args]);}) as typeof session.send);}if(first){first=false;const on=session.on.bind(session);t.mock.method(session,"on",((type:string,listener:(event:any)=>void)=>on(type as never,(event:any)=>{if(type==="Network.requestWillBeSent"&&event.request.headers["opc-request-id"])setTimeout(()=>listener(event),defaults.delayMetadataMs);else listener(event);})) as typeof session.on);}return session;});return page;});return context;});}
    return browser;
  };
  const sources = (page: Page): ConsoleSourceBoundary => { const proofs=new WeakSet<ConsoleSourceProof>();let disposed=false;return {async capture(signal){signal.throwIfAborted();const p=Object.freeze({}) as ConsoleSourceProof;proofs.add(p);return p;},assert(p){if(disposed||!state.sourceValid||!proofs.has(p))throw Error("fixture source");},dispose(){disposed=true;}}; };
  const { openOciConsoleBrowser } = await import("../oci-console-browser.ts");
  driver = await openOciConsoleBrowser({controlMode:defaults.controlMode,tempDir:data,expected:expectedConsole,scope:consoleScope,expiresAt:Date.now()+60000,lifecycle:lifecycle.signal,assertOwned:async()=>{if(!state.owned)throw Error("owner changed");},dependencies:{launch,...defaults.realSources?{}:{sources}}});
  const page=(await browser!.pages()).find(p=>p.url().startsWith("https://cloud.oracle.com"))!;
  return {driver,page,state,data,launchOptions,browser:browser!,lifecycle};
}

// Valid-input setup only; phase/refusal tests pass a previously issued frame.
async function freshInput(driver: ConsoleBrowser, event: FixtureInput) {
  const frame = await driver.frame();
  await driver.input(event, frame.frameRef, () => {});
}

test("retained Console browser verifies and reads only a fresh bounded outline in the same owned context", options, async t => {
  const f=await fixture(t), context=f.page.browserContext();
  assert.equal(f.launchOptions?.pipe,true); assert.equal(f.launchOptions?.acceptInsecureCerts,undefined);
  await freshInput(f.driver, {type:"wheel",deltaY:1});
  const current = await f.driver.frame(); assert.equal(current.width,800);
  assert.equal((await f.driver.verify(new AbortController().signal)).matched,true);
  await assert.rejects(f.driver.input({type:"text",text:"after handback"}, current.frameRef, () => {}));
  const outline=await f.driver.readPage(new AbortController().signal);
  assert.equal(f.state.reads,3); assert.equal(f.page.browserContext(),context);
  assert.ok(outline.headings.includes("Owned Console"));
  for(const value of [expectedConsole.userOcid,expectedConsole.tenancyOcid,expectedConsole.domainOcid,"fixture-secret","private form heading","ST$fixture-private",f.data])assert.equal(JSON.stringify(outline).includes(value),false);
  await f.driver.assertRetained(new AbortController().signal); await f.driver.close();
  assert.deepEqual(await readdir(f.data),["owned-resources-v1"]);
});

test("an allowed Console document replacement refuses old displayed input before real dispatch and accepts a refreshed frame", options, async t => {
  const launch = puppeteer.launch.bind(puppeteer);
  let launched: Browser | undefined;
  t.mock.method(puppeteer, "launch", async (input: Parameters<typeof puppeteer.launch>[0]) => {
    try { launched = await launch(input); return launched; }
    catch (error) {
      const message = error instanceof ProtocolError && error.originalMessage ? error.originalMessage : error instanceof Error ? error.message : "";
      t.diagnostic(JSON.stringify({ classification: "console_launch_failure_only", protocolError: error instanceof ProtocolError,
        timeout: /timed out|timeout/i.test(message), targetClosed: /target closed|session closed/i.test(message),
        command: ["Target.setAutoAttach", "Target.getTargets", "Browser.getVersion", "Network.enable", "Page.enable", "Emulation.setDeviceMetricsOverride"]
          .find(name => message.includes(name)) ?? "other" }));
      throw error;
    }
  });
  const f = await fixture(t).catch(error => {
    t.diagnostic(JSON.stringify({ classification: "console_startup_failure_only", launchReturned: Boolean(launched), browserConnected: launched?.connected ?? false,
      childExited: Boolean(launched?.process() && (launched.process()!.exitCode !== null || launched.process()!.signalCode !== null)) }));
    throw error;
  }), target = f.page.target(), context = f.page.browserContext();
  let effects = 0, claims = 0;
  const send = f.page.keyboard.sendCharacter.bind(f.page.keyboard), claim = () => { claims++; };
  t.mock.method(f.page.keyboard, "sendCharacter", async (text: string) => { effects++; await send(text); });
  try {
    const a = await f.driver.frame();
    await f.page.reload({ waitUntil: "domcontentloaded", timeout: 6000 });
    assert.equal(f.page.target() === target && f.page.browserContext() === context, true);
    const refused = await f.driver.input({ type: "text", text: "old Console observation" }, a.frameRef, claim).then(() => false, error => error instanceof StaleFrameError);
    t.diagnostic(JSON.stringify({ classification: "actual_console_allowed_document_replacement", sameOwner: true, refused, keyboardEffects: effects, inputClaims: claims }));
    assert.equal(effects, 0); assert.equal(refused, true); assert.equal(claims, 1);
    await f.page.focus("input");
    await f.page.$eval("input", input => input.select());
    const b = await f.driver.frame();
    await f.driver.input({ type: "text", text: "fresh Console observation" }, b.frameRef, claim);
    assert.equal(effects, 1); assert.equal(claims, 2);
    t.diagnostic(JSON.stringify(await f.page.$eval("input", input => ({ classification: "console_fresh_input_observation",
      containsFresh: input.value.includes("fresh Console observation"), startsFresh: input.value.startsWith("fresh Console observation"),
      endsFresh: input.value.endsWith("fresh Console observation"), focused: document.activeElement === input }))));
    assert.equal(await f.page.$eval("input", input => input.value === "fresh Console observation"), true);
  } finally {
    await f.driver.close();
    assert.equal(f.browser.connected, false);
    assert.deepEqual(await readdir(f.data), ["owned-resources-v1"]);
  }
});

test("verification blocks input immediately and denies refresh and unrelated requests", options, async t => {
  const f=await fixture(t); let entered!:()=>void,release!:()=>void;
  const waiting=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
  f.state.beforeRead=async()=>{entered();await held;};
  const frame = await f.driver.frame();
  const verifying=f.driver.verify(new AbortController().signal);void verifying.catch(()=>{});
  await assert.rejects(f.driver.input({type:"text",text:"must not dispatch"}, frame.frameRef, () => {})); await waiting;
  assert.equal(await f.page.evaluate(origin=>fetch(origin+"/unrelated").then(()=>true,()=>false),expectedConsole.domainOrigin),false);
  assert.equal(f.state.unrelated,0);release();await verifying;
  await f.page.evaluate(()=>{(globalThis as any).refreshBeforeRead=true;});
  await assert.rejects(f.driver.readPage(new AbortController().signal)); assert.equal(f.state.refresh,0);
});

test("a configured Console viewport change is refused before claiming or dispatching input", options, async t => {
  const f = await fixture(t), frame = await f.driver.frame();
  let effects = 0, claims = 0;
  const send = f.page.keyboard.sendCharacter.bind(f.page.keyboard);
  t.mock.method(f.page.keyboard, "sendCharacter", async (text: string) => { effects++; await send(text); });
  try {
    await f.page.setViewport({ width: 801, height: 600, deviceScaleFactor: 1 });
    const refused = await f.driver.input({ type: "text", text: "mismatched Console geometry" }, frame.frameRef, () => { claims++; })
      .then(() => false, error => (error as { code?: string }).code === "browser_unavailable");
    t.diagnostic(JSON.stringify({ classification: "actual_console_viewport_change", refused, keyboardEffects: effects, inputClaims: claims }));
    assert.equal(effects, 0); assert.equal(claims, 0); assert.equal(refused, true);
  } finally {
    await f.driver.close();
    assert.equal(f.browser.connected, false);
    assert.deepEqual(await readdir(f.data), ["owned-resources-v1"]);
  }
});

test("a screenshot dependency exception cannot impersonate a trusted capture invalidation", options, async t => {
  const f = await fixture(t);
  t.mock.method(f.page, "screenshot", async () => { throw new StaleFrameError(); });
  try {
    const generic = await f.driver.frame().then(() => false, error => {
      t.diagnostic(JSON.stringify({ classification: "console_capture_exception_origin", preservedAsTrustedStale: error instanceof StaleFrameError }));
      return !(error instanceof StaleFrameError) && (error as { code?: string }).code === "browser_unavailable";
    });
    assert.equal(generic, true);
  } finally { await f.driver.close(); }
});

test("stopping a Console browser invalidates queued work and retains no public account material", options, async t => {
  const f=await fixture(t), frame = await f.driver.frame();const closing=f.driver.close();
  await assert.rejects(f.driver.input({type:"key",key:"Enter"}, frame.frameRef, () => {}));await assert.rejects(f.driver.readPage(new AbortController().signal));await closing;
  await assert.rejects(f.driver.assertRetained(new AbortController().signal));
});

test("Console outlines satisfy the public bounded text contract after redaction and bidi removal", options, async t => {
  const f=await fixture(t);
  await f.page.evaluate(()=>{document.title="长".repeat(200)+"\u202esecret";document.querySelector("h1")!.textContent="Heading "+"x".repeat(200)+"\u2066";});
  const outline=await f.driver.readPage(new AbortController().signal);
  assert.ok(outline.title.length<=128);assert.ok(Buffer.byteLength(outline.title)<=512);
  assert.ok(outline.headings.every(value=>value.length<=128&&!/[\u202a-\u202e\u2066-\u2069]/u.test(value)));
  assert.equal(/[\u202a-\u202e\u2066-\u2069]/u.test(outline.title),false);
});

test("Console handback drains an active input and held HTTP before admitting its self-read", options, async t => {
  const f=await fixture(t), frame = await f.driver.frame();let inputEntered!:()=>void,inputRelease!:()=>void,otherEntered!:()=>void,otherRelease!:()=>void;
  const inputWaiting=new Promise<void>(r=>{inputEntered=r;}),inputHeld=new Promise<void>(r=>{inputRelease=r;});
  const otherWaiting=new Promise<void>(r=>{otherEntered=r;}),otherHeld=new Promise<void>(r=>{otherRelease=r;});
  const send=f.page.keyboard.sendCharacter.bind(f.page.keyboard);t.mock.method(f.page.keyboard,"sendCharacter",async (text:string)=>{inputEntered();await inputHeld;await send(text);});
  let httpStopped=false;f.page.on("requestfailed",request=>{if(request.url().endsWith("/unrelated"))httpStopped=true;});
  f.state.beforeOther=async()=>{otherEntered();await otherHeld;};
  const http=f.page.evaluate(origin=>fetch(origin+"/unrelated").then(()=>true,()=>false),expectedConsole.domainOrigin);
  await otherWaiting;const active=f.driver.input({type:"text",text:"fixture input"}, frame.frameRef, () => {});await inputWaiting;
  f.state.beforeRead=async()=>{assert.equal(httpStopped,true);};
  const handback=f.driver.verify(new AbortController().signal);void handback.catch(()=>{});
  await assert.rejects(f.driver.input({type:"key",key:"Enter"}, frame.frameRef, () => {}));assert.equal(f.state.reads,0);
  try{inputRelease();await assert.rejects(active);assert.equal(await http,false);await handback;}finally{inputRelease();otherRelease();}
});

test("long-lived channels are denied before provider code and source or navigation changes revoke retention", options, async t => {
  const f=await fixture(t);
  const channels=await f.page.evaluate(()=>["WebSocket","WebSocketStream","WebTransport","EventSource","Worker","SharedWorker","RTCPeerConnection","webkitRTCPeerConnection"].map(name=>{try{new (globalThis as any)[name]("https://cloud.oracle.com/unrelated");return false;}catch{return true;}}));
  assert.deepEqual(channels,[true,true,true,true,true,true,true,true]);assert.equal(f.state.unrelated,0);
  await f.driver.verify(new AbortController().signal);f.state.sourceValid=false;
  await assert.rejects(f.driver.assertRetained(new AbortController().signal));f.state.sourceValid=true;
  await f.page.evaluate(()=>history.pushState({},"","#changed")).catch(()=>{});
  await assert.rejects(f.driver.assertRetained(new AbortController().signal));
});

test("cancelling a held Console self-read closes the exact profile and never replays queued operations", options, async t => {
  const f=await fixture(t), frame = await f.driver.frame();let entered!:()=>void,release!:()=>void;
  const waiting=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});f.state.beforeRead=async()=>{entered();await held;};
  const controller=new AbortController(),pending=f.driver.verify(controller.signal);void pending.catch(()=>{});await waiting;controller.abort();
  try {await assert.rejects(pending);await assert.rejects(f.driver.readPage(new AbortController().signal));await assert.rejects(f.driver.input({type:"key",key:"Enter"}, frame.frameRef, () => {}));assert.equal(f.state.reads,1);assert.equal(f.browser.connected,false);assert.deepEqual(await readdir(f.data),["owned-resources-v1"]);}finally{release();}
});

test("default Console source attestation refuses fixture-only scripts before any protected identity request", options, async t => {
  const f=await fixture(t,{realSources:true});await assert.rejects(f.driver.verify(new AbortController().signal));assert.equal(f.state.reads,0);assert.equal(f.browser.connected,false);
});

test("navigation during outline collection prevents stale page text from escaping", options, async t => {
  const f=await fixture(t);
  await f.page.evaluate(()=>{Object.defineProperty(document.querySelector("h1"),"innerText",{get(){history.pushState({},"","#substituted-document");return "stale outline";}});});
  await assert.rejects(f.driver.readPage(new AbortController().signal));await assert.rejects(f.driver.assertRetained(new AbortController().signal));
});

test("uncertain Console launch journals a browser-only profile without CLI account artifacts", options, async t => {
  const data=await mkdtemp(join(await realpath(tmpdir()),"console-launch-uncertain-"));await chmod(data,0o700);t.after(()=>rm(data,{recursive:true,force:true}));
  const {openOciConsoleBrowser,ConsoleBrowserError}=await import("../oci-console-browser.ts");
  await assert.rejects(openOciConsoleBrowser({tempDir:data,expected:expectedConsole,scope:consoleScope,expiresAt:Date.now()+60000,lifecycle:new AbortController().signal,assertOwned:async()=>{},dependencies:{launch:async()=>{throw Error("fixture unknown launch");}}}),error=>error instanceof ConsoleBrowserError&&error.cleanupUncertain);
  const entries=await readdir(data),profile=entries.find(name=>name.startsWith("oci-browser-"))!;
  assert.deepEqual(await readdir(join(data,profile)),[]);
  const records=await readdir(join(data,"owned-resources-v1"));const record=JSON.parse(await readFile(join(data,"owned-resources-v1",records.find(name=>name.endsWith(".json"))!),"utf8"));
  assert.equal(record.kind,"browser_profile");assert.equal(record.writers[0].role,"browser");assert.equal(record.writers[0].state,"pending");
  for(const value of [expectedConsole.userOcid,expectedConsole.tenancyOcid,expectedConsole.domainOcid,"configFile","tokenLocation","oci_api_key"])assert.equal(JSON.stringify(record).includes(value),false);
});

test("a held exact profile removal reports bounded uncertainty and late completion never acknowledges release", options, async t => {
  const f=await fixture(t);let entered!:()=>void,release!:()=>void,removed!:()=>void;
  const waiting=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;}),lateRemoval=new Promise<void>(r=>{removed=r;});const original=fs.rm.bind(fs);
  t.mock.method(fs,"rm",async(path:Parameters<typeof fs.rm>[0],settings:Parameters<typeof fs.rm>[1])=>{if(String(path).startsWith(f.data+"/oci-browser-")){entered();await held;await original(path,settings);removed();}else await original(path,settings);});
  const closing=f.driver.close();void closing.catch(()=>{});await waiting;let timer!:ReturnType<typeof setTimeout>,outcome="";
  try{outcome=await Promise.race([closing.then(()=>"acknowledged",error=>error.cleanupUncertain?"uncertain":"other"),new Promise<string>(resolve=>{timer=setTimeout(()=>resolve("hung"),1800);})]);}finally{clearTimeout(timer);release();await closing.catch(()=>{});await lateRemoval;}
  assert.equal(outcome,"uncertain");
  const records=await readdir(join(f.data,"owned-resources-v1"));const record=JSON.parse(await readFile(join(f.data,"owned-resources-v1",records.find(name=>name.endsWith(".json"))!),"utf8"));
  assert.equal(record.state,"releasing");assert.equal(record.entries[0].state,"removing");assert.equal(record.writers[0].state,"attached");await assert.rejects(f.driver.close());
});

test("new pages remain debugger-paused before any traffic even while exact browser closure is held", options, async t => {
  const f=await fixture(t);let closingEntered!:()=>void,release!:()=>void,paused!:()=>void;
  const closingWaiting=new Promise<void>(r=>{closingEntered=r;}),held=new Promise<void>(r=>{release=r;}),pausedWaiting=new Promise<void>(r=>{paused=r;});
  f.state.onPausedPage=paused;const original=f.browser.close.bind(f.browser);t.mock.method(f.browser,"close",async()=>{closingEntered();await held;await original();});
  const popup=f.page.evaluate(()=>{window.open("https://cloud.oracle.com/unrelated");});void popup.catch(()=>{});await closingWaiting;let timer!:ReturnType<typeof setTimeout>;
  try {const isPaused=await Promise.race([pausedWaiting.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),300);})]);assert.equal(isPaused,true);assert.equal(f.state.unrelated,0);}finally{clearTimeout(timer);release();await popup.catch(()=>{});await f.driver.close();}
});

test("exact preflight waits for its owned-frame CDP provenance instead of assuming cross-session event order", options, async t => {
  const f=await fixture(t,{delayMetadataMs:50});assert.equal((await f.driver.verify(new AbortController().signal)).matched,true);assert.equal(f.state.reads,1);
});


test("host Console uses its visible private context and fences renderer input before retained verification", options, async t => {
  const f = await fixture(t, { controlMode: "host" }), context = f.page.browserContext();
  assert.equal(f.launchOptions?.headless, false, "Explicit host mode must create a visible owned Console window.");
  let claims = 0;
  await assert.rejects(f.driver.frame());
  await assert.rejects(f.driver.input({ type: "text", text: "remote effect" }, "00000000-0000-4000-8000-000000000000", () => { claims++; }));
  assert.equal(claims, 0);
  await f.page.focus("input"); await f.page.keyboard.type("local draft");
  const before = await f.page.$eval("input", input => input.value);
  assert.ok(before.includes("local draft"), "Renderer keyboard input must work before handback.");
  await f.page.click("#local-effect");
  assert.equal(await f.page.evaluate(() => (globalThis as any).localEffects), 1);
  f.state.beforeRead = async () => {
    await f.page.focus("input"); await f.page.keyboard.type("concurrent input");
    await f.page.click("#local-effect");
    assert.equal(await f.page.evaluate(() => (globalThis as any).localEffects), 1, "Mouse input must be blocked before the signed read.");
    assert.equal(await f.page.$eval("input", input => input.value), before, "Input must be fenced before the signed identity read begins.");
  };
  assert.equal((await f.driver.verify(new AbortController().signal)).matched, true);
  await f.driver.assertRetained(new AbortController().signal);
  assert.equal(f.page.browserContext(), context);
  await f.page.focus("input"); await f.page.keyboard.type("retained input");
  assert.equal(await f.page.$eval("input", input => input.value), before);
});

test("host Console never verifies or retains a page when the renderer input fence has no ACK", options, async t => {
  const f = await fixture(t, { controlMode: "host", refuseInputFence: true });
  await assert.rejects(f.driver.verify(new AbortController().signal));
  assert.equal(f.state.reads, 0, "No signed identity request may precede the input-fence acknowledgement.");
  assert.equal(f.browser.connected, false);
});


test("null Console presentation mode refuses before browser launch", async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "console-invalid-mode-")); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true })); let launches = 0;
  const { openOciConsoleBrowser } = await import("../oci-console-browser.ts");
  await assert.rejects(Reflect.apply(openOciConsoleBrowser, undefined, [{ controlMode: null, tempDir: root, expected: expectedConsole, scope: consoleScope,
    expiresAt: Date.now() + 60000, lifecycle: new AbortController().signal, assertOwned: async () => {},
    dependencies: { launch: async () => { launches++; throw new Error("unexpected launch"); } } }]));
  assert.equal(launches, 0); assert.deepEqual(await readdir(root), []);
});
