// Dynamic provider-plugin loader and canonical provider data exports.
//
// Every provider is an in-process ESM plugin. Built-in plugins are emitted
// under dist/plugins/<id>/index.js; user plugins live under the stable
// ~/.claude/plugins/topgauge-cc/query_plugins/<id>/ directory.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveEffectiveCurrencies, resolveEffectiveIntervals } from "./config.ts";
import * as diagnostics from "./diagnostics.ts";
import type {
  CurrenciesConfig,
  IntervalConfig,
  ProviderEntry,
} from "./types.ts";
import type {
  AccountCreditPlugin,
  Balance,
  BalanceEntry,
  Interval,
  PluginContext,
  Quota,
} from "./plugins/data.ts";
import { ensureBalance, ensureQuota } from "./plugins/parsers.ts";

export type {
  AccountCreditPlugin,
  Balance,
  BalanceEntry,
  Interval,
  PluginContext,
  Quota,
};
export {
  ensureInterval,
  ensureQuota,
  ensureBalance,
  parseBalance,
  parseQuota,
} from "./plugins/parsers.ts";

const PLUGIN_TIMEOUT_MS = 5_000;
const BUILTIN_PLUGIN_IDS = new Set(["minimax", "deepseek"]);
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]+$/;

export function queryPluginsDir(): string {
  return join(homedir(), ".claude", "plugins", "topgauge-cc", "query_plugins");
}

function assertSafeProviderId(providerId: string): void {
  if (!PROVIDER_ID_RE.test(providerId)) {
    throw new Error(`invalid provider id "${providerId}"`);
  }
}

export function queryPluginPath(providerId: string): string {
  assertSafeProviderId(providerId);
  return join(queryPluginsDir(), providerId, "index.js");
}

function builtInPluginPath(providerId: string, root: "dist" | "src"): string {
  assertSafeProviderId(providerId);
  // root=dist → dist/plugins/<id>/index.js (emitted by
  // scripts/copy-builtin-plugins.mjs); root=src →
  // src/plugins/<id>/index.js (used by node --import tsx unit
  // tests before a build, where the dist copy may be stale).
  const base = root === "dist"
    ? dirname(fileURLToPath(import.meta.url))
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
  return join(base, "plugins", providerId, "index.js");
}

export function resolveBuiltInPluginOnDisk(providerId: string): string {
  if (!BUILTIN_PLUGIN_IDS.has(providerId)) return builtInPluginPath(providerId, "dist");
  const emitted = builtInPluginPath(providerId, "dist");
  if (existsSync(emitted)) return emitted;
  const source = builtInPluginPath(providerId, "src");
  if (existsSync(source)) return source;
  return emitted;
}

export function resolvePluginOnDisk(providerId: string): string {
  assertSafeProviderId(providerId);
  if (BUILTIN_PLUGIN_IDS.has(providerId)) return resolveBuiltInPluginOnDisk(providerId);
  const js = queryPluginPath(providerId);
  if (existsSync(js)) return js;
  const mjs = join(queryPluginsDir(), providerId, "index.mjs");
  if (existsSync(mjs)) return mjs;
  return js;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveAuthenticationKey(entry: ProviderEntry, token: string): string {
  return entry.AUTHENTICATION_KEY ?? token ?? "";
}

export async function pluginTransport(
  providerId: string,
  token: string,
  context?: PluginContext,
): Promise<unknown> {
  const pluginPath = resolvePluginOnDisk(providerId);
  let module: { default?: AccountCreditPlugin };
  try {
    module = (await import(pathToFileURL(pluginPath).href)) as typeof module;
  } catch (error) {
    const message = `plugin ${pluginPath}: ${(error as Error).message ?? String(error)}`;
    diagnostics.append("warning", "fetch", message, Date.now());
    throw new Error(message);
  }

  const plugin = module.default;
  if (!plugin || typeof plugin !== "object" ||
      typeof plugin.fetchAccountCredit !== "function") {
    const message = `plugin ${pluginPath}: default export must be { fetchAccountCredit(authenticationKey, context?) }`;
    diagnostics.append("warning", "fetch", message, Date.now());
    throw new Error(message);
  }

  try {
    return await withTimeout(
      Promise.resolve(plugin.fetchAccountCredit(token, context)),
      PLUGIN_TIMEOUT_MS,
      `plugin ${pluginPath} fetchAccountCredit`,
    );
  } catch (error) {
    const message = `plugin ${pluginPath} fetchAccountCredit: ${(error as Error).message ?? String(error)}`;
    diagnostics.append("warning", "fetch", message, Date.now());
    throw new Error(message);
  }
}

export async function fetchForProviderById(
  providerName: string | null,
  entry: ProviderEntry | null,
  token: string,
  signal: AbortSignal | undefined,
): Promise<Quota | Balance | null> {
  if (!entry || !providerName) return null;
  const context: PluginContext = {
    providerId: providerName,
    type: entry.TYPE,
    intervals: resolveEffectiveIntervals(providerName, entry),
    currencies: resolveEffectiveCurrencies(providerName, entry),
    ...(signal ? { signal } : {}),
  };
  const partial = await pluginTransport(
    providerName,
    resolveAuthenticationKey(entry, token),
    context,
  );
  // Host-side ensure. The plugin returned whatever shape its `fill`
  // decided to project; we run the canonical normaliser here so the
  // plugin author never has to know about ensureQuota /
  // ensureBalance / Quota / Balance types.
  if (entry.TYPE === "Quota") return ensureQuota(partial);
  if (entry.TYPE === "BALANCE") return ensureBalance(partial);
  const exhaustive: never = entry.TYPE;
  throw new Error(`unsupported provider TYPE: ${exhaustive}`);
}

export async function fetchQuota(
  token: string,
  _endpoint = "",
  _signal?: AbortSignal,
  provider: ProviderEntry | null = null,
): Promise<Quota | null> {
  const entry = provider ?? {
    TYPE: "Quota" as const,
    BASE_URL_COMPARED_TO: "https://api.minimaxi.com/anthropic",
    COMPARE_METHOD: "EXACT" as const,
  };
  const partial = await pluginTransport("minimax", resolveAuthenticationKey(entry, token), {
    providerId: "minimax",
    type: "Quota",
    intervals: resolveEffectiveIntervals("minimax", entry),
    currencies: resolveEffectiveCurrencies("minimax", entry),
  });
  return ensureQuota(partial);
}

export async function fetchBalance(
  token: string,
  _endpoint = "",
  _signal?: AbortSignal,
  provider: ProviderEntry | null = null,
): Promise<Balance | null> {
  const entry = provider ?? {
    TYPE: "BALANCE" as const,
    BASE_URL_COMPARED_TO: "https://api.deepseek.com/anthropic",
    COMPARE_METHOD: "EXACT" as const,
  };
  const partial = await pluginTransport("deepseek", resolveAuthenticationKey(entry, token), {
    providerId: "deepseek",
    type: "BALANCE",
    intervals: resolveEffectiveIntervals("deepseek", entry),
    currencies: resolveEffectiveCurrencies("deepseek", entry),
  });
  return ensureBalance(partial);
}

const DEEPSEEK_PREFIX = "https://api.deepseek.com";

export function isDeepSeekBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  const lower = baseUrl.toLowerCase();
  if (!lower.startsWith(DEEPSEEK_PREFIX)) return false;
  const tail = baseUrl[DEEPSEEK_PREFIX.length];
  return tail === undefined || tail === "/" || tail === "?" || tail === "#";
}

// Kept for consumers that need to construct context in tests.
export type { CurrenciesConfig, IntervalConfig };
