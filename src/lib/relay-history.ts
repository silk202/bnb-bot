/**
 * Relay probe-history — persistent per-relay latency samples.
 *
 * Every RelayStatusCard probe round appends one sample per relay to a small
 * ring buffer kept in localStorage (survives reloads, capped so storage
 * never grows unbounded). The History page reads the buffer to chart relay
 * responsiveness over time; the health layer uses the same samples for
 * degraded-state detection.
 */

const STORAGE_KEY = "flashbolt.relay-probe-history.v1";
/** Max samples retained per relay (oldest dropped). */
const MAX_SAMPLES = 60;

export interface RelayProbeSample {
  /** Epoch ms of the probe. */
  t: number;
  /** Round-trip latency in ms (probes that failed record latency too). */
  latencyMs: number;
  /** Whether the relay answered with the correct chain. */
  ok: boolean;
  /** Short error reason when !ok. */
  error?: string;
}

type RelayHistoryMap = Record<string, RelayProbeSample[]>;

let cache: RelayHistoryMap | null = null;

function load(): RelayHistoryMap {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as RelayHistoryMap) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist(map: RelayHistoryMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage full/unavailable — in-memory cache still serves this session.
  }
}

/** Record one probe result for a relay. */
export function recordProbeSample(endpoint: string, sample: RelayProbeSample): void {
  const map = load();
  const list = map[endpoint] ?? [];
  list.push(sample);
  if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
  map[endpoint] = list;
  cache = map;
  persist(map);
}

/** All samples for a relay, oldest first. */
export function getProbeHistory(endpoint: string): RelayProbeSample[] {
  return [...(load()[endpoint] ?? [])];
}

/** Every tracked relay with its sample count (for UI lists). */
export function trackedRelays(): Array<{ endpoint: string; samples: number }> {
  return Object.entries(load())
    .map(([endpoint, samples]) => ({ endpoint, samples: samples.length }))
    .filter((r) => r.samples > 0)
    .sort((a, b) => b.samples - a.samples);
}

/** Clear one relay's history, or everything when omitted. */
export function clearProbeHistory(endpoint?: string): void {
  if (endpoint) delete load()[endpoint];
  else cache = {};
  persist(load());
}

/** Convenience aggregates for charts. */
export function summarizeProbeHistory(endpoint: string): {
  count: number;
  avgLatencyMs: number;
  p50: number;
  p95: number;
  uptimePct: number;
} {
  const samples = getProbeHistory(endpoint);
  if (samples.length === 0) {
    return { count: 0, avgLatencyMs: 0, p50: 0, p95: 0, uptimePct: 0 };
  }
  const lats = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const at = (p: number) => lats[Math.min(lats.length - 1, Math.floor((p / 100) * lats.length))];
  return {
    count: samples.length,
    avgLatencyMs: lats.reduce((a, b) => a + b, 0) / lats.length,
    p50: at(50),
    p95: at(95),
    uptimePct: Math.round((samples.filter((s) => s.ok).length / samples.length) * 100),
  };
}
