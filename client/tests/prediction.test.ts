import assert from "node:assert/strict";
import test from "node:test";
import { createTank } from "../src/physics.js";
import { ClientPrediction } from "../src/prediction.js";

test("prediction replays only unacknowledged inputs from the server state", () => {
  const initial = createTank("pilot", "#fff", 480, 300);
  const prediction = new ClientPrediction(initial);
  const first = prediction.step({ forward: true });
  const second = prediction.step({ forward: true });
  const serverState = createTank("pilot", "#fff", 480, 300);
  const correction = prediction.reconcile(serverState, first);
  assert.equal(prediction.pendingCount, 1);
  assert.equal(prediction.sequence, second);
  assert.ok(correction > 0);
  assert.notDeepEqual(prediction.state, serverState);
});

test("prediction correction fades out over approximately 100 ms", () => {
  const prediction = new ClientPrediction(
    createTank("pilot", "#fff", 100, 100),
  );
  prediction.step({ forward: true });
  const visualBefore = prediction.visualState;
  prediction.reconcile(createTank("pilot", "#fff", 100, 100), 1);
  const correction = prediction.correctionMagnitude;
  prediction.advance(0.05);
  assert.ok(prediction.correctionMagnitude > 0);
  assert.ok(prediction.correctionMagnitude < correction);
  prediction.advance(0.05);
  assert.equal(prediction.correctionMagnitude, 0);
  assert.deepEqual(prediction.visualState, prediction.state);
  assert.notDeepEqual(visualBefore, prediction.visualState);
});
