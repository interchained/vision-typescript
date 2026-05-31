import type { Logger } from "pino";

/**
 * Vision chain adapter — reads live Interchained (ITC) layer-1 stats from the
 * public block explorer API at https://vision.interchained.org/api.
 *
 * Verified endpoints (no auth required):
 *   - GET /api/hashrate      -> { hashrate, label, window_blocks }
 *   - GET /api/difficulty    -> { difficulty, tip_height }
 *   - GET /api/stats/supply  -> { circulating_sats, height, txouts, ... }
 *   - GET /api/blocks        -> { items: [{ height, hash, time, miner_address, ... }] }
 *
 * ITC uses 8 decimals (sats), so circulating ITC = circulating_sats / 1e8.
 * All calls degrade gracefully: if the explorer is unreachable the summary is
 * returned with source = "unavailable" and null/zero fields.
 */

const BASE_URL = "https://vision.interchained.org/api";
const TIMEOUT_MS = 12_000;
const SATS_PER_ITC = 100_000_000;

export interface ChainBlockSummary {
  height: number;
  hash: string;
  time: number;
  minerAddress: string | null;
  explorerUrl: string;
}

export interface ChainStats {
  source: "live" | "unavailable";
  tipHeight: number | null;
  hashrate: number | null;
  hashrateLabel: string | null;
  difficulty: number | null;
  circulatingItc: number | null;
  circulatingSats: number | null;
  windowBlocks: number | null;
  explorerUrl: string;
  recentBlocks: ChainBlockSummary[];
  fetchedAt: string;
}

async function getJson<T>(path: string, log?: Logger): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as T | null;
  } catch (err) {
    log?.warn({ err, path }, "Vision chain request error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function getChainStats(log?: Logger): Promise<ChainStats> {
  const [hashrate, difficulty, supply, blocks] = await Promise.all([
    getJson<{ hashrate?: number; label?: string; window_blocks?: number }>(
      "/hashrate",
      log,
    ),
    getJson<{ difficulty?: number; tip_height?: number }>("/difficulty", log),
    getJson<{ circulating_sats?: number; height?: number }>(
      "/stats/supply",
      log,
    ),
    getJson<{
      items?: Array<{
        height?: number;
        hash?: string;
        time?: number;
        miner_address?: string | null;
      }>;
    }>("/blocks", log),
  ]);

  const anyLive = Boolean(hashrate || difficulty || supply || blocks);
  const circulatingSats = num(supply?.circulating_sats);
  const recentBlocks: ChainBlockSummary[] = (blocks?.items ?? [])
    .slice(0, 8)
    .filter((b): b is { height: number; hash: string; time: number; miner_address: string | null } =>
      typeof b?.height === "number" && typeof b?.hash === "string",
    )
    .map((b) => ({
      height: b.height,
      hash: b.hash,
      time: typeof b.time === "number" ? b.time : 0,
      minerAddress: b.miner_address ?? null,
      explorerUrl: `https://vision.interchained.org/block/${b.hash}`,
    }));

  return {
    source: anyLive ? "live" : "unavailable",
    tipHeight: num(difficulty?.tip_height) ?? num(supply?.height),
    hashrate: num(hashrate?.hashrate),
    hashrateLabel: typeof hashrate?.label === "string" ? hashrate.label : null,
    difficulty: num(difficulty?.difficulty),
    circulatingItc:
      circulatingSats != null ? circulatingSats / SATS_PER_ITC : null,
    circulatingSats,
    windowBlocks: num(hashrate?.window_blocks),
    explorerUrl: "https://vision.interchained.org",
    recentBlocks,
    fetchedAt: new Date().toISOString(),
  };
}
