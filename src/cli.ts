#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import { Command } from "commander";
import { address, createNoopSigner } from "@solana/kit";
import { formatTokenAmount, parseTokenAmount } from "./amount.js";
import {
  configuredValue,
  DEFAULT_RPC,
  loadWalletSigner,
  MAIN_MARKET,
  privateKeyFromEnv,
} from "./config.js";
import {
  buildFlashLoan,
  createAtaInstruction,
  deriveAssociatedTokenAccount,
  fetchTokenAccount,
  loadMarket,
  reserveDisplaySymbol,
  reserveMatchesAsset,
  reserveSummary,
  rpcClient,
  selectReserve,
} from "./kamino.js";
import { instructionSummary, loadStrategy } from "./strategy.js";
import { createSignedTransaction, sendAndConfirm, simulate } from "./transaction.js";
import {
  centerBlock,
  color,
  printBanner,
  printError,
  printMenu,
  printPlanSummary,
  Prompter,
  renderTable,
  safeJsonStringify,
  terminalLink,
} from "./ui.js";

loadEnv({ quiet: true });

interface LoanOptions {
  rpc: string;
  market: string;
  asset?: string;
  reserve?: string;
  amount: string;
  tokenAccount?: string;
  strategy?: string;
  keypair?: string;
  yes?: boolean;
  json?: boolean;
}

interface ReserveOptions {
  rpc: string;
  market: string;
  asset?: string;
  json: boolean;
}

function loanOptions(command: Command, needsKeypair: boolean): Command {
  command
    .option("--rpc <url>", "Solana RPC URL", process.env.SOLANA_RPC_URL || DEFAULT_RPC)
    .option("--market <address>", "Kamino lending market", process.env.KAMINO_MARKET || MAIN_MARKET)
    .option("--asset <symbol>", "reserve token symbol, for example USDC")
    .option("--reserve <address>", "exact reserve address; preferred when symbols are duplicated")
    .requiredOption("--amount <tokens>", "flash-loan amount in token units")
    .option("--token-account <address>", "override the automatically derived wallet ATA")
    .option("--strategy <path>", "JSON file containing atomic strategy instructions")
    .option("--json", "print machine-readable JSON", false);
  if (needsKeypair) command.option("--keypair <path>", "fallback Solana keypair JSON (PRIVATE_KEY env takes priority)", configuredValue(process.env.KEYPAIR_PATH));
  return command;
}

async function prepare(options: LoanOptions, withSecret: boolean) {
  const rpc = rpcClient(options.rpc);
  const market = await loadMarket(rpc, options.market);
  const reserve = selectReserve(market, options);
  const requestedTokenAccount = configuredValue(options.tokenAccount);
  const privateKey = privateKeyFromEnv();
  const keypairPath = configuredValue(options.keypair) ?? configuredValue(process.env.KEYPAIR_PATH);
  const walletSigner = withSecret || !requestedTokenAccount
    ? await loadWalletSigner({ privateKey, keypairPath })
    : undefined;
  const tokenAccountAddress = address(requestedTokenAccount ?? await deriveAssociatedTokenAccount({
    mint: reserve.getLiquidityMint(),
    owner: walletSigner!.address,
    tokenProgram: reserve.getLiquidityTokenProgram(),
  }));
  const existingTokenAccount = await fetchTokenAccount(rpc, tokenAccountAddress);
  if (!existingTokenAccount && requestedTokenAccount) {
    throw new Error(`Override token account ${tokenAccountAddress} belum ada on-chain; hapus --token-account agar ATA dibuat otomatis`);
  }
  const tokenAccount = existingTokenAccount ?? {
    address: tokenAccountAddress,
    mint: reserve.getLiquidityMint(),
    owner: walletSigner!.address,
    amount: 0n,
    decimals: reserve.getMintDecimals(),
  };
  const signer = withSecret ? walletSigner! : createNoopSigner(walletSigner?.address ?? tokenAccount.owner);
  const setupInstructions = existingTokenAccount ? [] : [await createAtaInstruction({
    payer: signer,
    mint: tokenAccount.mint,
    owner: tokenAccount.owner,
    tokenProgram: reserve.getLiquidityTokenProgram(),
    ata: tokenAccount.address,
  })];
  const strategy = await loadStrategy(options.strategy, signer);
  const amountBaseUnits = parseTokenAmount(options.amount, reserve.getMintDecimals());
  const build = await buildFlashLoan({
    market,
    reserve,
    signer,
    tokenAccount,
    amountBaseUnits,
    strategy,
    setupInstructions,
  });
  const summary = {
    network: "solana-mainnet-beta",
    rpc: options.rpc,
    market: market.getAddress(),
    wallet: signer.address,
    tokenAccount: tokenAccount.address,
    tokenAccountStatus: existingTokenAccount ? "EXISTING" : "CREATE AUTOMATICALLY",
    asset: reserveDisplaySymbol(reserve),
    reserve: reserve.address,
    mint: reserve.getLiquidityMint(),
    amount: formatTokenAmount(amountBaseUnits, reserve.getMintDecimals()),
    amountBaseUnits: amountBaseUnits.toString(),
    estimatedFee: formatTokenAmount(build.feeBaseUnits, reserve.getMintDecimals()),
    estimatedFeeBaseUnits: build.feeBaseUnits.toString(),
    initialTokenBalance: formatTokenAmount(tokenAccount.amount, reserve.getMintDecimals()),
    initialTokenBalanceBaseUnits: tokenAccount.amount.toString(),
    feeShortfall: formatTokenAmount(
      tokenAccount.amount >= build.feeBaseUnits ? 0n : build.feeBaseUnits - tokenAccount.amount,
      reserve.getMintDecimals(),
    ),
    feeShortfallBaseUnits: (tokenAccount.amount >= build.feeBaseUnits ? 0n : build.feeBaseUnits - tokenAccount.amount).toString(),
    strategy: strategy.name,
    borrowInstructionIndex: build.borrowInstructionIndex,
    repayInstructionIndex: build.instructions.length - 1,
    instructions: build.instructions.map(instructionSummary),
    warning:
      !existingTokenAccount && strategy.instructions.length === 0
        ? "ATA will be created automatically, but a no-op strategy still needs enough token balance to pay the flash-loan fee."
        : strategy.instructions.length === 0
        ? "No-op flash loan: the token account must already contain enough tokens to pay the fee."
        : "Strategy must leave principal plus fee in the configured token account before repay.",
  };
  return { rpc, signer, build, summary };
}

function assertNoOpRepayable(summary: Record<string, unknown>): void {
  if (summary.strategy !== "no-op") return;
  const shortfall = BigInt(String(summary.feeShortfallBaseUnits));
  if (shortfall === 0n) return;
  throw new Error(
    `Saldo fee kurang ${summary.feeShortfall} ${summary.asset}. Kirim minimal ${summary.feeShortfall} ${summary.asset} ke ATA ${summary.tokenAccount}, atau isi Strategy JSON yang menghasilkan principal + fee.`,
  );
}

function printSimulation(result: Awaited<ReturnType<typeof simulate>>): void {
  console.log(safeJsonStringify({
    err: result.value.err,
    unitsConsumed: result.value.unitsConsumed?.toString(),
    logs: result.value.logs,
  }, 2));
}

function shortAddress(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function compactNumber(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat("en-US", {
    notation: Math.abs(numeric) >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 6,
  }).format(numeric);
}

function compactUsd(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return `$${value}`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(numeric);
}

const MIN_LIQUIDITY_USD_CENTS = 10_000_000n;
const SUPPORTED_FLASH_ASSETS = new Set([
  "wsol",
  "usdt",
  "usdc",
  "dsol",
  "jitosol",
  "cbbtc",
  "jupsol",
  "usdg",
  "pyusd",
  "usds",
  "eurc",
]);

function isEligibleReserve(row: ReserveRow): boolean {
  return SUPPORTED_FLASH_ASSETS.has(row.symbol.toLowerCase())
    && row.flashLoanEnabled
    && row.priceValid
    && BigInt(row.availableBaseUnits) > 0n
    && BigInt(row.availableValueUsdCents) >= MIN_LIQUIDITY_USD_CENTS;
}

function printLiquidityScan(rows: Awaited<ReturnType<typeof getReserveRows>>): void {
  const ready = selectableReserveRows(rows);
  console.log(`\n${centerBlock(color.bold(color.cyan("SOLANA MAINNET / LIQUIDITY")))}`);
  console.log(centerBlock(`${color.green(`${ready.length} assets ready`)} ${color.dim("• minimum $100K •")} ${rows.length} reserves scanned`));
  if (!ready.length) {
    console.log(centerBlock(color.yellow("Tidak ada reserve flashloan bernilai minimal $100K.")));
    return;
  }
  console.log(centerBlock(renderTable(
    [
      { title: "#", align: "right" }, { title: "ASSET" },
      { title: "AVAILABLE", align: "right" }, { title: "VALUE", align: "right" },
      { title: "FEE", align: "right" }, { title: "RESERVE" },
    ],
    ready.map((row, index) => [
      color.magenta(String(index + 1).padStart(2, "0")),
      color.yellow(row.symbol),
      color.white(compactNumber(row.available)),
      color.green(compactUsd(row.availableValueUsd)),
      color.white(`${(Number(row.flashLoanFeeRate) * 100).toFixed(4)}%`),
      color.cyan(shortAddress(row.reserve)),
    ]),
  )));
}

function printSimulationPanel(result: Awaited<ReturnType<typeof simulate>>): void {
  const success = !result.value.err;
  console.log(`\n${centerBlock(color.bold(color.cyan("TRANSACTION SIMULATION")))}`);
  console.log(centerBlock(renderTable(
    [{ title: "FIELD" }, { title: "RESULT" }],
    [
      [color.dim("STATUS"), success ? color.green("SUCCESS") : color.red("FAILED")],
      [color.dim("COMPUTE"), color.white(`${result.value.unitsConsumed?.toString() ?? "n/a"} units`)],
      [color.dim("BROADCAST"), color.magenta("NOT SENT")],
    ],
  )));
  if (!success) {
    console.log(centerBlock(color.red(`Error: ${safeJsonStringify(result.value.err)}`)));
    const logs = result.value.logs?.slice(-12) ?? [];
    if (logs.length) console.log(logs.map((line) => color.dim(`  ${line}`)).join("\n"));
  } else {
    console.log(centerBlock(`${color.green("✓")} Simulasi flashloan berhasil`));
  }
}

async function getReserveRows(options: Omit<ReserveOptions, "json">) {
  const market = await loadMarket(rpcClient(options.rpc), options.market);
  return market.getReserves()
    .filter((reserve) => !options.asset || reserveMatchesAsset(reserve, options.asset))
    .map(reserveSummary)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

type ReserveRow = Awaited<ReturnType<typeof getReserveRows>>[number];

function selectableReserveRows(rows: ReserveRow[]): ReserveRow[] {
  const bestBySymbol = new Map<string, ReserveRow>();
  for (const row of rows) {
    if (!isEligibleReserve(row)) continue;
    const key = row.symbol.toLowerCase();
    const current = bestBySymbol.get(key);
    if (!current || BigInt(row.availableValueUsdCents) > BigInt(current.availableValueUsdCents)) {
      bestBySymbol.set(key, row);
    }
  }
  return [...bestBySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function selectPromptedReserve(allRows: ReserveRow[], choices: ReserveRow[], input: string): ReserveRow {
  const normalized = input.trim();
  if (/^\d+$/.test(normalized)) {
    const selected = choices[Number(normalized) - 1];
    if (selected) return selected;
  }
  const bySymbol = choices.find((row) => row.symbol.toLowerCase() === normalized.toLowerCase());
  if (bySymbol) return bySymbol;
  const byAddress = allRows.find((row) => row.reserve === normalized);
  if (byAddress && isEligibleReserve(byAddress)) return byAddress;
  throw new Error(`Asset "${input}" tidak tersedia. Pilih nomor, simbol, atau reserve address dari daftar.`);
}

async function promptReserveChoice(prompter: Prompter, rpc: string, market: string): Promise<ReserveRow> {
  console.log(centerBlock(`${color.cyan("◌")} ${color.dim("Membaca reserve Kamino dari Solana...")}`));
  const rows = await getReserveRows({ rpc, market });
  const choices = selectableReserveRows(rows);
  if (!choices.length) throw new Error("Tidak ada reserve flashloan dengan likuiditas tersedia");
  printLiquidityScan(choices);
  const input = await prompter.required("Pilih asset", undefined, "nomor / simbol / reserve address");
  return selectPromptedReserve(rows, choices, input);
}

async function promptLoanOptions(prompter: Prompter): Promise<LoanOptions> {
  const rpc = process.env.SOLANA_RPC_URL || DEFAULT_RPC;
  const market = process.env.KAMINO_MARKET || MAIN_MARKET;
  const selected = await promptReserveChoice(prompter, rpc, market);
  const amount = await prompter.required("Masukkan nominal", undefined, "contoh: 1000");
  const privateKey = privateKeyFromEnv();
  const keypairPath = configuredValue(process.env.KEYPAIR_PATH);
  const wallet = await loadWalletSigner({ privateKey, keypairPath });
  const tokenAccount = await deriveAssociatedTokenAccount({
    mint: selected.mint,
    owner: wallet.address,
    tokenProgram: selected.tokenProgram,
  });
  console.log(centerBlock(`${color.green("✓")} Wallet terdeteksi ${color.cyan(wallet.address)}`));
  console.log(centerBlock(`${color.green("✓")} ATA otomatis ${color.cyan(tokenAccount)}`));
  const strategy = await prompter.ask("Strategy JSON", undefined, "kosong = no-op; perlu saldo untuk fee");
  const options: LoanOptions = { rpc, market, amount, reserve: selected.reserve };
  if (strategy) options.strategy = strategy;
  if (keypairPath && !privateKey) options.keypair = keypairPath;
  return options;
}

async function runInteractive(): Promise<void> {
  const prompter = new Prompter();
  try {
    printBanner();
    while (true) {
      printMenu();
      const choice = await prompter.ask("Pilih menu", undefined, "[0-3]");
      if (choice === "0") {
        console.log(centerBlock(color.dim("Toolkit ditutup.\n")));
        return;
      }
      try {
        if (choice === "1") {
          const rpc = process.env.SOLANA_RPC_URL || DEFAULT_RPC;
          const market = process.env.KAMINO_MARKET || MAIN_MARKET;
          const asset = await prompter.ask("Filter asset", undefined, "kosong = semua");
          console.log(centerBlock(`${color.cyan("◌")} ${color.dim("Membaca reserve Kamino dari Solana...")}`));
          const options: Omit<ReserveOptions, "json"> = { rpc, market };
          if (asset) options.asset = asset;
          printLiquidityScan(await getReserveRows(options));
        } else if (choice === "2") {
          const options = await promptLoanOptions(prompter);
          console.log(centerBlock(`${color.cyan("◌")} ${color.dim("Memvalidasi plan on-chain...")}`));
          const { summary } = await prepare(options, false);
          printPlanSummary(summary);
          console.log(centerBlock(`${color.magenta("[PLAN]")} Tidak ada transaksi dikirim`));
        } else if (choice === "3") {
          const options = await promptLoanOptions(prompter);
          console.log(centerBlock(`${color.cyan("◌")} ${color.dim("Menyusun transaksi atomik...")}`));
          const { rpc, signer, build, summary } = await prepare(options, true);
          printPlanSummary(summary);
          assertNoOpRepayable(summary);
          const transaction = await createSignedTransaction(rpc, signer, build.instructions);
          console.log(centerBlock(`${color.cyan("◌")} ${color.dim("Menjalankan simulasi wajib...")}`));
          const result = await simulate(rpc, transaction);
          printSimulationPanel(result);
          if (result.value.err) {
            console.log(centerBlock(`${color.red("✗")} Simulasi gagal ${color.dim("• transaksi tidak dikirim")}`));
          } else {
            const confirmation = await prompter.ask(
              `Kirim flashloan ${summary.amount} ${summary.asset} di Solana mainnet`,
              undefined,
              "ketik YES",
            );
            if (confirmation !== "YES") {
              console.log(centerBlock(`${color.magenta("[PLAN]")} Broadcast dibatalkan`));
            } else {
              console.log(centerBlock(`${color.yellow("◌")} ${color.dim("Mengirim transaksi mainnet...")}`));
              const signature = await sendAndConfirm(options.rpc, rpc, transaction);
              const explorer = `https://solscan.io/tx/${signature}`;
              console.log(`\n${centerBlock(color.bold(color.green("TRANSACTION CONFIRMED")))}`);
              console.log(centerBlock(`${color.green("✓")} FLASHLOAN  ${color.dim(shortAddress(signature))}  ${terminalLink("OPEN ↗", explorer)}`));
            }
          }
        } else {
          console.log(centerBlock(color.yellow("Menu tidak valid. Pilih 0–3.")));
        }
      } catch (error) {
        printError(error);
      }
      await prompter.pause();
      if (process.stdout.isTTY) console.clear();
      printBanner();
    }
  } finally {
    prompter.close();
  }
}

const program = new Command()
  .name("kamino-tools")
  .description("Build, inspect, simulate, and execute atomic Kamino Lend flash loans")
  .showHelpAfterError();

program
  .command("reserves")
  .description("list reserves and their current flash-loan state")
  .option("--rpc <url>", "Solana RPC URL", process.env.SOLANA_RPC_URL || DEFAULT_RPC)
  .option("--market <address>", "Kamino lending market", process.env.KAMINO_MARKET || MAIN_MARKET)
  .option("--asset <symbol>", "filter by token symbol")
  .option("--json", "print JSON instead of a table", false)
  .action(async (options: ReserveOptions) => {
    const rows = await getReserveRows(options);
    if (options.json) console.log(JSON.stringify(selectableReserveRows(rows), null, 2));
    else {
      printBanner();
      printLiquidityScan(rows);
    }
  });

program
  .command("interactive")
  .alias("i")
  .description("open the guided terminal menu")
  .action(runInteractive);

loanOptions(program.command("plan").description("validate inputs and print the exact atomic instruction order"), false)
  .action(async (options: LoanOptions) => {
    const { summary } = await prepare(options, false);
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else {
      printBanner();
      printPlanSummary(summary);
      console.log(centerBlock(`${color.magenta("[PLAN]")} Tidak ada transaksi dikirim`));
    }
  });

loanOptions(program.command("simulate").description("sign and simulate without broadcasting"), true)
  .action(async (options: LoanOptions) => {
    const { rpc, signer, build, summary } = await prepare(options, true);
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else {
      printBanner();
      printPlanSummary(summary);
    }
    assertNoOpRepayable(summary);
    const transaction = await createSignedTransaction(rpc, signer, build.instructions);
    const result = await simulate(rpc, transaction);
    if (options.json) printSimulation(result);
    else printSimulationPanel(result);
    if (result.value.err) process.exitCode = 2;
  });

loanOptions(program.command("execute").description("simulate, then broadcast the atomic transaction"), true)
  .option("--yes", "acknowledge mainnet broadcast", false)
  .action(async (options: LoanOptions) => {
    if (!options.yes) throw new Error("Refusing mainnet broadcast without --yes");
    const { rpc, signer, build, summary } = await prepare(options, true);
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else {
      printBanner();
      printPlanSummary(summary);
    }
    assertNoOpRepayable(summary);
    const transaction = await createSignedTransaction(rpc, signer, build.instructions);
    const simulation = await simulate(rpc, transaction);
    if (options.json) printSimulation(simulation);
    else printSimulationPanel(simulation);
    if (simulation.value.err) throw new Error("Simulation failed; transaction was not broadcast");
    const signature = await sendAndConfirm(options.rpc, rpc, transaction);
    const explorer = `https://solscan.io/tx/${signature}`;
    if (options.json) console.log(JSON.stringify({ signature, explorer }, null, 2));
    else {
      console.log(`\n${centerBlock(color.bold(color.green("TRANSACTION CONFIRMED")))}`);
      console.log(centerBlock(`${color.green("✓")} FLASHLOAN  ${color.dim(shortAddress(signature))}  ${terminalLink("OPEN ↗", explorer)}`));
    }
  });

async function main(): Promise<void> {
  if (process.argv.length === 2) {
    if (process.stdin.isTTY) await runInteractive();
    else program.outputHelp();
    return;
  }
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  printError(error);
  process.exitCode = 1;
});
