import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const colorEnabled = Boolean(stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb");
const ansiPattern = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const oscPattern = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;

function paint(code: string | number, value: unknown): string {
  const text = String(value);
  return colorEnabled ? `\u001B[${code}m${text}\u001B[0m` : text;
}

export const color = {
  bold: (value: unknown) => paint(1, value),
  dim: (value: unknown) => paint(2, value),
  red: (value: unknown) => paint("38;5;203", value),
  green: (value: unknown) => paint("38;5;82", value),
  yellow: (value: unknown) => paint("38;5;220", value),
  blue: (value: unknown) => paint("38;5;75", value),
  magenta: (value: unknown) => paint("38;5;213", value),
  cyan: (value: unknown) => paint("38;5;45", value),
  white: (value: unknown) => paint("38;5;255", value),
};

function visibleLength(value: string): number {
  return value.replace(oscPattern, "").replace(ansiPattern, "").length;
}

function pad(value: string, width: number, align: "left" | "right"): string {
  const missing = Math.max(0, width - visibleLength(value));
  return align === "right" ? `${" ".repeat(missing)}${value}` : `${value}${" ".repeat(missing)}`;
}

export type TableColumn = { title: string; align?: "left" | "right" };

export function renderTable(columns: TableColumn[], rows: string[][]): string {
  const widths = columns.map((column, index) => Math.max(
    visibleLength(column.title),
    ...rows.flatMap((row) => (row[index] ?? "").split("\n").map(visibleLength)),
  ));
  const border = (left: string, middle: string, right: string) => color.dim(
    `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`,
  );
  const renderRow = (values: string[], header = false): string[] => {
    const cells = values.map((value) => value.split("\n"));
    const height = Math.max(...cells.map((cell) => cell.length));
    return Array.from({ length: height }, (_, line) => `${color.dim("│")}${cells.map((cell, index) => {
      const offset = Math.floor((height - cell.length) / 2);
      const value = cell[line - offset] ?? "";
      const rendered = header ? color.bold(color.cyan(value)) : value;
      return ` ${pad(rendered, widths[index]!, columns[index]!.align ?? "left")} `;
    }).join(color.dim("│"))}${color.dim("│")}`);
  };
  return [
    border("┌", "┬", "┐"),
    ...renderRow(columns.map((column) => column.title), true),
    border("├", "┼", "┤"),
    ...rows.flatMap((row) => renderRow(row)),
    border("└", "┴", "┘"),
  ].join("\n");
}

export function centerBlock(value: string, width = stdout.columns ?? 80): string {
  return value.split("\n").map((line) => {
    const left = Math.max(0, Math.floor((width - visibleLength(line)) / 2));
    return `${" ".repeat(left)}${line}`;
  }).join("\n");
}

export function promptText(label: string, hint?: string): string {
  const suffix = hint ? ` ${color.dim(hint)}` : "";
  return `${color.magenta("›")} ${color.bold(color.white(label))}${suffix}: `;
}

export function safeJsonStringify(value: unknown, space?: number): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item, space);
}

export function renderBanner(): string {
  // Rasterized from Omarchy Font Regular, then reduced to terminal half-block cells.
  const logo = [
    "   ▄    ▄    ▄▄▄▄▄▄    ▄▄▄███▄▄▄▄     ▄ ▄▄▄         ▄▄▄▄",
    "  ▄█  ▄██▀  ██▀▀▀██  ▄██▀▀███▀▀▀██  ▄██ ████▀██▄  ▄██▀▀██▄",
    "  ██ ██▀    ██   ██  ███  ███   ██  ███ ███   ██  ███  ███",
    " ▄████▀    ▄██▄▄▄██  ███  ███   ██  ███ ███   ██  ███  ███",
    "▀▀████▄    ███▀▀▀██  ███  ███   ██  ███ ███   ██  ███  ███",
    "  ██ ██▄    ██   ██  ███  ███   ██  ███ ███   ██  ███  ███",
    "  ██  ▀██▄  ██   ██  ▀██  ███   ██  ██▀ ▀██   ██  ▀██▄▄██▀",
    "  █▀    ▀   ▀▀   ▀     ▀  ▀▀▀   ▀   ▀     ▀   ▀     ▀▀▀▀",
  ];
  const palette = ["38;5;45", "38;5;51", "38;5;81", "38;5;117", "38;5;141", "38;5;177", "38;5;213", "38;5;207"];
  const banner = [
    ...logo.map((line, index) => paint(palette[index]!, line)),
    "",
    color.bold(color.magenta("S O L A N A  ·  L E N D  ·  T O O L K I T")),
    color.white("Atomic Kamino flashloan CLI"),
    color.dim(`BUILT BY ${color.cyan("0xRapzz")}`),
    "",
    `${color.cyan("KAMINO")}  ${color.dim("•")}  ${color.green("ATOMIC")}  ${color.dim("•")}  ${color.yellow("SOLANA")}`,
    color.dim("─".repeat(58)),
  ].join("\n");
  return `\n${centerBlock(banner)}\n`;
}

export function printBanner(): void {
  console.log(renderBanner());
}

export function printMenu(): void {
  console.log(centerBlock(color.bold(color.cyan("MAIN MENU"))));
  console.log(centerBlock(renderTable(
    [{ title: "#" }, { title: "ACTION" }, { title: "DESCRIPTION" }],
    [
      [color.magenta("1"), color.white("LIQUIDITY SCAN"), color.dim("Find flash-borrowable reserves")],
      [color.magenta("2"), color.white("FLASHLOAN PLAN"), color.dim("Validate wallet and strategy")],
      [color.magenta("3"), color.green("RUN FLASHLOAN"), color.dim("Simulate, then optionally broadcast")],
      [color.dim("0"), color.dim("EXIT"), color.dim("Close toolkit")],
    ],
  )));
  console.log("");
}

export class Prompter {
  private readonly readline: Interface;

  constructor() {
    this.readline = createInterface({ input: stdin, output: stdout });
  }

  async ask(label: string, defaultValue?: string, hint?: string): Promise<string> {
    const defaultHint = defaultValue ? `[${defaultValue}]` : hint;
    const answer = (await this.readline.question(centerBlock(promptText(label, defaultHint)))).trim();
    return answer || defaultValue || "";
  }

  async required(label: string, defaultValue?: string, hint?: string): Promise<string> {
    while (true) {
      const answer = await this.ask(label, defaultValue, hint);
      if (answer) return answer;
      console.log(centerBlock(color.red("Nilai ini wajib diisi.")));
    }
  }

  async pause(): Promise<void> {
    await this.readline.question(centerBlock(color.dim("Tekan Enter untuk kembali ke menu...")));
  }

  close(): void {
    this.readline.close();
  }
}

export function printPlanSummary(summary: Record<string, unknown>): void {
  console.log(`\n${centerBlock(color.bold(color.cyan("FLASHLOAN PLAN")))}`);
  console.log(centerBlock(renderTable(
    [{ title: "FIELD" }, { title: "DETAIL" }],
    [
      [color.dim("NETWORK"), color.yellow("Solana Mainnet")],
      [color.dim("ASSET"), color.yellow(String(summary.asset))],
      [color.dim("AMOUNT"), color.bold(color.green(`${summary.amount} ${summary.asset}`))],
      [color.dim("EST. FEE"), color.yellow(`${summary.estimatedFee} ${summary.asset}`)],
      [color.dim("TOKEN BALANCE"), color.white(`${summary.initialTokenBalance} ${summary.asset}`)],
      [color.dim("FEE SHORTFALL"), summary.feeShortfall === "0"
        ? color.green(`0 ${summary.asset}`)
        : color.red(`${summary.feeShortfall} ${summary.asset}`)],
      [color.dim("RESERVE"), color.cyan(String(summary.reserve))],
      [color.dim("WALLET"), color.cyan(String(summary.wallet))],
      [color.dim("TOKEN ACCOUNT"), color.white(String(summary.tokenAccountStatus))],
      [color.dim("STRATEGY"), color.white(String(summary.strategy))],
      [color.dim("MODE"), color.green("ATOMIC / BORROW → STRATEGY → REPAY")],
    ],
  )));
  console.log(centerBlock(`${color.yellow("!")} ${color.dim(String(summary.warning))}`));
}

export function printError(error: unknown): void {
  console.error(centerBlock(`${color.red("[ERROR]")} ${error instanceof Error ? error.message : String(error)}`));
  if (process.env.DEBUG && error instanceof Error && error.stack) console.error(color.dim(error.stack));
}

export function terminalLink(label: string, url: string): string {
  if (!colorEnabled) return url;
  return `\u001B]8;;${url}\u0007${color.cyan(label)}\u001B]8;;\u0007`;
}
