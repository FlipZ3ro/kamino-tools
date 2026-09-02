const U64_MAX = (1n << 64n) - 1n;

export function parseTokenAmount(value: string, decimals: number): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`Invalid token amount: ${value}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`Invalid mint decimals: ${decimals}`);
  }

  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new Error(`${value} has more than ${decimals} decimal places`);
  }

  const baseUnits = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (baseUnits <= 0n) throw new Error("Amount must be greater than zero");
  if (baseUnits > U64_MAX) throw new Error("Amount exceeds Solana u64 maximum");
  return baseUnits;
}

export function formatTokenAmount(value: bigint, decimals: number): string {
  const factor = 10n ** BigInt(decimals);
  const whole = value / factor;
  const fraction = (value % factor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
