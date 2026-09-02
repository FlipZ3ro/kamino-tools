import BN from "bn.js";
import { Decimal } from "decimal.js";
import {
  KaminoMarket,
  PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  flashBorrowReserveLiquidity,
  flashRepayReserveLiquidity,
  getAssociatedTokenAddress,
  type KaminoReserve,
} from "@kamino-finance/klend-sdk";
import {
  address,
  createSolanaRpc,
  none,
  type Address,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";
import { SYSVAR_INSTRUCTIONS_ADDRESS } from "@solana/sysvars";
import { formatTokenAmount } from "./amount.js";
import type { LoadedStrategy } from "./strategy.js";

const U64_MAX = ((1n << 64n) - 1n).toString();
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

export interface TokenAccountInfo {
  address: Address;
  mint: Address;
  owner: Address;
  amount: bigint;
  decimals: number;
}

export interface FlashLoanBuild {
  instructions: Instruction[];
  borrowInstructionIndex: number;
  setupInstructionCount: number;
  feeBaseUnits: bigint;
  reserve: KaminoReserve;
}

export function rpcClient(url: string): Rpc<SolanaRpcApi> {
  return createSolanaRpc(url);
}

export async function deriveAssociatedTokenAccount(params: {
  mint: string;
  owner: Address;
  tokenProgram: string;
}): Promise<Address> {
  return getAssociatedTokenAddress(address(params.mint), params.owner, address(params.tokenProgram));
}

export async function loadMarket(rpc: Rpc<SolanaRpcApi>, marketValue: string): Promise<KaminoMarket> {
  const marketAddress = address(marketValue);
  const market = await KaminoMarket.load(rpc, marketAddress, 350, PROGRAM_ID);
  if (!market) throw new Error(`Kamino market not found: ${marketAddress}`);
  return market;
}

export function selectReserve(market: KaminoMarket, selector: { asset?: string; reserve?: string }): KaminoReserve {
  if (selector.reserve) {
    const selected = market.getReserveByAddress(address(selector.reserve));
    if (!selected) throw new Error(`Reserve ${selector.reserve} is not part of market ${market.getAddress()}`);
    return selected;
  }
  if (!selector.asset) throw new Error("Pass either --asset or --reserve");
  const matches = market.getReserves().filter((item) => reserveMatchesAsset(item, selector.asset!));
  if (matches.length === 0) throw new Error(`No reserve found for symbol ${selector.asset}`);
  const enabled = matches.filter(isFlashLoanEnabled);
  const candidates = enabled.length > 0 ? enabled : matches;
  return candidates.reduce((best, item) =>
    item.getLiquidityAvailableAmount().gt(best.getLiquidityAvailableAmount()) ? item : best
  );
}

export function reserveDisplaySymbol(reserve: KaminoReserve): string {
  return reserve.getLiquidityMint().toString() === WRAPPED_SOL_MINT ? "WSOL" : reserve.getTokenSymbol();
}

export function reserveMatchesAsset(reserve: KaminoReserve, asset: string): boolean {
  const normalized = asset.trim().toLowerCase();
  if (reserve.getLiquidityMint().toString() === WRAPPED_SOL_MINT) {
    return normalized === "sol" || normalized === "wsol" || normalized === "sol/wsol";
  }
  return reserve.getTokenSymbol().toLowerCase() === normalized;
}

export function isFlashLoanEnabled(reserve: KaminoReserve): boolean {
  return reserve.state.config.fees.flashLoanFeeSf.toString() !== U64_MAX;
}

export function reserveSummary(reserve: KaminoReserve) {
  const decimals = reserve.getMintDecimals();
  const availableDecimal = reserve.getLiquidityAvailableAmount().floor();
  const available = BigInt(availableDecimal.toFixed(0));
  const oraclePrice = reserve.getOracleMarketPrice();
  const availableValueUsd = availableDecimal.mul(oraclePrice).div(reserve.getMintFactor());
  return {
    symbol: reserveDisplaySymbol(reserve),
    protocolSymbol: reserve.getTokenSymbol(),
    reserve: reserve.address,
    mint: reserve.getLiquidityMint(),
    tokenProgram: reserve.getLiquidityTokenProgram(),
    supplyVault: reserve.state.liquidity.supplyVault,
    feeVault: reserve.state.liquidity.feeVault,
    decimals,
    availableBaseUnits: available.toString(),
    available: formatTokenAmount(available, decimals),
    oraclePriceUsd: oraclePrice.toString(),
    priceValid: reserve.hasValidOraclePrice(),
    availableValueUsd: availableValueUsd.toFixed(2),
    availableValueUsdCents: availableValueUsd.mul(100).floor().toFixed(0),
    flashLoanEnabled: isFlashLoanEnabled(reserve),
    flashLoanFeeRate: reserve.getFlashLoanFee().toString(),
  };
}

export async function fetchTokenAccount(rpc: Rpc<SolanaRpcApi>, value: string): Promise<TokenAccountInfo | null> {
  const tokenAddress = address(value);
  const response = await rpc.getAccountInfo(tokenAddress, { commitment: "confirmed", encoding: "jsonParsed" }).send();
  const account = response.value as unknown as {
    data?: { program?: string; parsed?: { info?: { mint?: string; owner?: string; tokenAmount?: { amount?: string; decimals?: number } } } };
  } | null;
  if (!account) return null;
  const info = account?.data?.parsed?.info;
  if (!info?.mint || !info.owner || !info.tokenAmount?.amount || !Number.isInteger(info.tokenAmount.decimals)) {
    throw new Error(`${tokenAddress} is not a parsed SPL token account`);
  }
  return {
    address: tokenAddress,
    mint: address(info.mint),
    owner: address(info.owner),
    amount: BigInt(info.tokenAmount.amount),
    decimals: info.tokenAmount.decimals!,
  };
}

export async function createAtaInstruction(params: {
  payer: TransactionSigner;
  mint: Address;
  owner: Address;
  tokenProgram: Address;
  ata: Address;
}): Promise<Instruction> {
  const [derivedAta, instruction] = await createAssociatedTokenAccountIdempotentInstruction(
    params.payer,
    params.mint,
    params.owner,
    params.tokenProgram,
    params.ata,
  );
  if (derivedAta !== params.ata) throw new Error(`Derived ATA mismatch: expected ${params.ata}, received ${derivedAta}`);
  return instruction;
}

export async function buildFlashLoan(params: {
  market: KaminoMarket;
  reserve: KaminoReserve;
  signer: TransactionSigner;
  tokenAccount: TokenAccountInfo;
  amountBaseUnits: bigint;
  strategy: LoadedStrategy;
  setupInstructions?: Instruction[];
}): Promise<FlashLoanBuild> {
  const { market, reserve, signer, tokenAccount, amountBaseUnits, strategy } = params;
  const setupInstructions = params.setupInstructions ?? [];
  if (!isFlashLoanEnabled(reserve)) throw new Error(`Flash loans are disabled for reserve ${reserve.address}`);
  if (tokenAccount.owner !== signer.address) throw new Error(`Token account owner ${tokenAccount.owner} does not match wallet ${signer.address}`);
  if (tokenAccount.mint !== reserve.getLiquidityMint()) {
    throw new Error(`Token account mint ${tokenAccount.mint} does not match reserve mint ${reserve.getLiquidityMint()}`);
  }
  if (tokenAccount.decimals !== reserve.getMintDecimals()) throw new Error("Token account decimals do not match reserve decimals");
  const available = BigInt(reserve.getLiquidityAvailableAmount().floor().toFixed(0));
  if (amountBaseUnits > available) throw new Error(`Requested ${amountBaseUnits} base units, but reserve currently has ${available}`);
  if (strategy.preInstructions.length + setupInstructions.length > 254) {
    throw new Error("Too many setup/pre-instructions; borrow index must fit in u8");
  }

  const commonAccounts = {
    userTransferAuthority: signer,
    lendingMarketAuthority: await market.getLendingMarketAuthority(),
    lendingMarket: market.getAddress(),
    reserve: reserve.address,
    reserveLiquidityMint: reserve.getLiquidityMint(),
    reserveLiquidityFeeReceiver: reserve.state.liquidity.feeVault,
    referrerTokenState: none<Address>(),
    referrerAccount: none<Address>(),
    sysvarInfo: SYSVAR_INSTRUCTIONS_ADDRESS,
    tokenProgram: reserve.getLiquidityTokenProgram(),
  };
  const amount = new BN(amountBaseUnits.toString());
  const borrowInstructionIndex = strategy.preInstructions.length + setupInstructions.length;
  const borrow = flashBorrowReserveLiquidity(
    { liquidityAmount: amount },
    {
      ...commonAccounts,
      reserveSourceLiquidity: reserve.state.liquidity.supplyVault,
      userDestinationLiquidity: tokenAccount.address,
    },
    [],
    market.programId
  );
  const repay = flashRepayReserveLiquidity(
    { liquidityAmount: amount, borrowInstructionIndex },
    {
      ...commonAccounts,
      reserveDestinationLiquidity: reserve.state.liquidity.supplyVault,
      userSourceLiquidity: tokenAccount.address,
    },
    [],
    market.programId
  );

  const fees = reserve.calculateFlashLoanFees(new Decimal(amountBaseUnits.toString()), market.state.referralFeeBps, false);
  const feeBaseUnits = BigInt(fees.protocolFees.add(fees.referrerFees).ceil().toFixed(0));
  return {
    instructions: [...strategy.preInstructions, ...setupInstructions, borrow, ...strategy.instructions, repay],
    borrowInstructionIndex,
    setupInstructionCount: setupInstructions.length,
    feeBaseUnits,
    reserve,
  };
}
