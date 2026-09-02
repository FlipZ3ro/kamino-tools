import assert from "node:assert/strict";
import test from "node:test";
import { configuredValue, parsePrivateKeyBytes, privateKeyFromEnv, required } from "../src/config.js";

test("configuredValue ignores empty and example placeholder values", () => {
  assert.equal(configuredValue(undefined), undefined);
  assert.equal(configuredValue("  "), undefined);
  assert.equal(configuredValue("YourTokenAccountAddress"), undefined);
  assert.equal(configuredValue("YOUR_USDC_TOKEN_ACCOUNT"), undefined);
  assert.equal(configuredValue("CHANGE_ME"), undefined);
});

test("configuredValue trims real values", () => {
  assert.equal(configuredValue("  ~/.config/solana/id.json  "), "~/.config/solana/id.json");
  assert.equal(configuredValue("RealSolanaAddress123"), "RealSolanaAddress123");
});

test("required rejects placeholder configuration", () => {
  assert.throws(() => required("CHANGE_ME", "CONFIG_VALUE"), /is required/);
});

test("privateKeyFromEnv accepts common names in priority order", () => {
  assert.equal(privateKeyFromEnv({ PK: "fallback", PRIVATE_KEY: "preferred" }), "preferred");
  assert.equal(privateKeyFromEnv({ WALLET_PRIVATE_KEY: "wallet-value" }), "wallet-value");
});

test("parses private keys from JSON, comma-separated bytes, and base58", () => {
  assert.equal(parsePrivateKeyBytes(JSON.stringify(Array(32).fill(1))).length, 32);
  assert.equal(parsePrivateKeyBytes(Array(64).fill(2).join(",")).length, 64);
  assert.equal(parsePrivateKeyBytes("1".repeat(64)).length, 64);
  assert.throws(() => parsePrivateKeyBytes("too-short"), /PRIVATE_KEY/);
});
