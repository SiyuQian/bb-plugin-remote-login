import assert from "node:assert/strict";
import test from "node:test";
import { FrameObservation } from "../frame-observation.ts";

function issue(observation: FrameObservation) {
  const reference = observation.issue(observation.begin());
  assert.equal(typeof reference, "string", "A successful current capture must issue an observation.");
  return reference!;
}

test("an issued observation permits one input and cannot be reissued from the same capture", () => {
  const observation = new FrameObservation(), capture = observation.begin(), reference = observation.issue(capture);
  assert.equal(typeof reference, "string");
  assert.equal(observation.issue(capture), null);
  assert.equal(observation.consume(reference!), true);
  assert.equal(observation.consume(reference!), false);
  assert.equal(observation.issue(capture), null);
});

test("starting a newer capture revokes the displayed observation before the next image is issued", () => {
  const observation = new FrameObservation(), prior = issue(observation), capture = observation.begin();
  assert.equal(observation.consume(prior), false);
  const current = observation.issue(capture);
  assert.equal(typeof current, "string");
  assert.equal(observation.consume(prior), false);
  assert.equal(observation.consume(current!), true);
});

test("a superseded asynchronous screenshot cannot issue or displace its successor", () => {
  const observation = new FrameObservation(), old = observation.begin(), current = observation.begin();
  assert.equal(observation.issue(old), null);
  const reference = observation.issue(current);
  assert.equal(typeof reference, "string");
  assert.equal(observation.issue(old), null);
  assert.equal(observation.consume(reference!), true);
});

test("document or authority invalidation rejects both an issued frame and a pending capture", () => {
  const observation = new FrameObservation(), prior = issue(observation);
  observation.invalidate(); assert.equal(observation.consume(prior), false);
  const capture = observation.begin();
  observation.invalidate(); assert.equal(observation.issue(capture), null);
  assert.equal(observation.consume(issue(observation)), true);
});

test("foreign or invented references do not consume the current owned observation", () => {
  const first = new FrameObservation(), second = new FrameObservation(), a = issue(first), b = issue(second);
  assert.equal(a === b, false);
  assert.equal(first.consume(b), false); assert.equal(first.consume("not-issued"), false);
  assert.equal(first.consume(a), true); assert.equal(second.consume(b), true);
});

test("an absent capture cannot mint a reference before an actual observation begins", () => {
  const observation = new FrameObservation();
  assert.equal(Reflect.apply(observation.issue, observation, [null]) === null, true);
  assert.equal(observation.consume(issue(observation)), true);
});
