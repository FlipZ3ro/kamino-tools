import assert from "node:assert/strict";
import test from "node:test";
import { renderBanner, renderTable, safeJsonStringify } from "../src/ui.js";

test("renders the Omarchy-font Kamino banner", () => {
  const banner = renderBanner();
  assert.match(banner, /KAMINO/);
  assert.match(banner, /▄▄▄███▄▄▄▄/);
  assert.match(banner, /S O L A N A  ·  L E N D  ·  T O O L K I T/);
  assert.match(banner, /0xRapzz/);
});

test("renders a bordered terminal table", () => {
  const table = renderTable(
    [{ title: "#" }, { title: "ACTION" }],
    [["1", "LIQUIDITY SCAN"]],
  );
  assert.match(table, /┌───┬────────────────┐/);
  assert.match(table, /LIQUIDITY SCAN/);
  assert.match(table, /└───┴────────────────┘/);
});

test("serializes bigint values returned by Solana RPC", () => {
  assert.equal(safeJsonStringify({ customError: 6012n }), '{"customError":"6012"}');
});
