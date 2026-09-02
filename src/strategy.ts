import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AccountRole,
  address,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

interface JsonAccount {
  address: string;
  writable?: boolean;
  signer?: boolean;
}

interface JsonInstruction {
  programAddress: string;
  accounts?: JsonAccount[];
  dataBase64?: string;
}

interface JsonStrategy {
  name?: string;
  preInstructions?: JsonInstruction[];
  instructions?: JsonInstruction[];
}

export interface LoadedStrategy {
  name: string;
  preInstructions: Instruction[];
  instructions: Instruction[];
}

function assertInstruction(value: unknown, location: string): asserts value is JsonInstruction {
  if (!value || typeof value !== "object") throw new Error(`${location} must be an object`);
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.programAddress !== "string") throw new Error(`${location}.programAddress is required`);
  if (candidate.accounts !== undefined && !Array.isArray(candidate.accounts)) throw new Error(`${location}.accounts must be an array`);
  if (candidate.dataBase64 !== undefined && typeof candidate.dataBase64 !== "string") throw new Error(`${location}.dataBase64 must be a string`);
}

function toInstruction(input: JsonInstruction, owner: TransactionSigner): Instruction {
  const accounts: Array<AccountMeta | AccountSignerMeta> = (input.accounts ?? []).map((item, index) => {
    if (!item || typeof item !== "object" || typeof item.address !== "string") {
      throw new Error(`Invalid strategy account at index ${index}`);
    }
    if (item.writable !== undefined && typeof item.writable !== "boolean") {
      throw new Error(`Strategy account writable flag at index ${index} must be boolean`);
    }
    if (item.signer !== undefined && typeof item.signer !== "boolean") {
      throw new Error(`Strategy account signer flag at index ${index} must be boolean`);
    }
    const accountAddress = address(item.address);
    if (item.signer) {
      if (accountAddress !== owner.address) {
        throw new Error(`Strategy requests unsupported signer ${accountAddress}; only the configured wallet may sign`);
      }
      return {
        address: accountAddress,
        role: item.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER,
        signer: owner,
      };
    }
    return { address: accountAddress, role: item.writable ? AccountRole.WRITABLE : AccountRole.READONLY };
  });

  const dataBase64 = input.dataBase64 ?? "";
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) {
    throw new Error(`Invalid base64 instruction data for program ${input.programAddress}`);
  }
  return {
    programAddress: address(input.programAddress),
    accounts,
    data: dataBase64 ? Uint8Array.from(Buffer.from(dataBase64, "base64")) : new Uint8Array(),
  };
}

export async function loadStrategy(path: string | undefined, owner: TransactionSigner): Promise<LoadedStrategy> {
  if (!path) return { name: "no-op", preInstructions: [], instructions: [] };
  const absolutePath = resolve(path);
  const parsed = JSON.parse(await readFile(absolutePath, "utf8")) as JsonStrategy;
  if (!parsed || typeof parsed !== "object") throw new Error("Strategy file must contain a JSON object");
  const pre = parsed.preInstructions ?? [];
  const middle = parsed.instructions ?? [];
  pre.forEach((value, index) => assertInstruction(value, `preInstructions[${index}]`));
  middle.forEach((value, index) => assertInstruction(value, `instructions[${index}]`));
  for (const instruction of pre) {
    if (instruction.programAddress !== COMPUTE_BUDGET_PROGRAM) {
      throw new Error("preInstructions may only target the Solana Compute Budget program");
    }
  }
  return {
    name: parsed.name?.trim() || absolutePath,
    preInstructions: pre.map((ix) => toInstruction(ix, owner)),
    instructions: middle.map((ix) => toInstruction(ix, owner)),
  };
}

export function instructionSummary(instruction: Instruction, index: number): { index: number; program: Address; accounts: number; dataBytes: number } {
  return {
    index,
    program: instruction.programAddress,
    accounts: instruction.accounts?.length ?? 0,
    dataBytes: instruction.data?.length ?? 0,
  };
}
