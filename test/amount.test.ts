import assert from "node:assert/strict";
import test from "node:test";
import { formatTokenAmount, parseTokenAmount } from "../src/amount.js";

test("parses token UI amounts without floating-point loss", () => {
  assert.equal(parseTokenAmount("1.000001", 6), 1_000_001n);
  assert.equal(parseTokenAmount("9007199254.740991", 6), 9_007_199_254_740_991n);
});

test("rejects excess precision and zero", () => {
  assert.throws(() => parseTokenAmount("0.0000001", 6), /more than 6/);
  assert.throws(() => parseTokenAmount("0", 6), /greater than zero/);
});

test("formats base units", () => {
  assert.equal(formatTokenAmount(1_230_000n, 6), "1.23");
  assert.equal(formatTokenAmount(5n, 0), "5");
});
