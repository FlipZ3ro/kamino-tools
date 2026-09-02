import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getBase58Encoder,
  type KeyPairSigner,
} from "@solana/kit";

export const MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
export const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

export function configuredValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (/(?:YOUR_|YourToken|CHANGE_ME|PLACEHOLDER|absolute\/path)/i.test(normalized)) return undefined;
  return normalized;
}

export function privateKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return configuredValue(env.SOLANA_PRIVATE_KEY)
    ?? configuredValue(env.PRIVATE_KEY)
    ?? configuredValue(env.WALLET_PRIVATE_KEY)
    ?? configuredValue(env.PK);
}

export function parsePrivateKeyBytes(value: string): Uint8Array {
  const normalized = value.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    parsed = undefined;
  }

  let bytes: Uint8Array;
  if (Array.isArray(parsed)) {
    if (parsed.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
      throw new Error("PRIVATE_KEY JSON must contain only byte values from 0 to 255");
    }
    bytes = Uint8Array.from(parsed as number[]);
  } else if (/^\d+(?:\s*,\s*\d+)+$/.test(normalized)) {
    const values = normalized.split(",").map((item) => Number(item.trim()));
    if (values.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
      throw new Error("PRIVATE_KEY byte list must contain values from 0 to 255");
    }
    bytes = Uint8Array.from(values);
  } else {
    try {
      bytes = Uint8Array.from(getBase58Encoder().encode(normalized));
    } catch {
      throw new Error("PRIVATE_KEY must be base58, a JSON byte array, or a comma-separated byte list");
    }
  }

  if (bytes.length !== 32 && bytes.length !== 64) {
    throw new Error(`PRIVATE_KEY must decode to 32 or 64 bytes (received ${bytes.length})`);
  }
  return bytes;
}

export async function loadPrivateKey(value: string): Promise<KeyPairSigner> {
  const bytes = parsePrivateKeyBytes(value);
  return bytes.length === 32
    ? createKeyPairSignerFromPrivateKeyBytes(bytes)
    : createKeyPairSignerFromBytes(bytes);
}

export async function loadKeypair(path: string): Promise<KeyPairSigner> {
  const expandedPath = path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  const absolutePath = resolve(expandedPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read keypair ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error("Keypair must be a Solana JSON array containing exactly 64 bytes");
  }
  return createKeyPairSignerFromBytes(Uint8Array.from(parsed as number[]));
}

export async function loadWalletSigner(options: {
  privateKey?: string | undefined;
  keypairPath?: string | undefined;
}): Promise<KeyPairSigner> {
  const privateKey = configuredValue(options.privateKey);
  if (privateKey) return loadPrivateKey(privateKey);
  const keypairPath = configuredValue(options.keypairPath);
  if (keypairPath) return loadKeypair(keypairPath);
  throw new Error("Set PRIVATE_KEY in .env (or provide --keypair as fallback)");
}

export function required(value: string | undefined, label: string): string {
  const configured = configuredValue(value);
  if (!configured) throw new Error(`${label} is required`);
  return configured;
}
