import assert from "node:assert/strict";
import test from "node:test";
import { address, createNoopSigner } from "@solana/kit";
import { loadStrategy } from "../src/strategy.js";

const signer = createNoopSigner(address("11111111111111111111111111111111"));

test("loads strategy instructions from strict JSON", async () => {
  const strategy = await loadStrategy("examples/strategy.example.json", signer);
  assert.equal(strategy.name, "replace-with-an-atomic-strategy");
  assert.equal(strategy.preInstructions.length, 0);
  assert.equal(strategy.instructions.length, 1);
  assert.equal(Buffer.from(strategy.instructions[0]!.data!).toString("utf8"), "kamino-tools");
});

test("defaults to a no-op strategy", async () => {
  const strategy = await loadStrategy(undefined, signer);
  assert.deepEqual(strategy, { name: "no-op", preInstructions: [], instructions: [] });
});
