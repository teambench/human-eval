/**
 * Region-based backend routing.
 *
 * We run two backends behind free Cloudflare tunnels:
 *   - sgp (Singapore, DigitalOcean sgp1) — best for APAC
 *   - nyc (New York, DigitalOcean nyc1)  — best for Americas / Europe
 *
 * On first load, probe both in parallel with a 2s timeout and remember
 * whichever responded first (lowest latency). Persist to localStorage so
 * subsequent loads skip the probe and paint instantly.
 *
 * Participants can override via the lobby's region picker (not yet wired up;
 * `?region=sgp|nyc` query param also forces a specific choice).
 */

export type RegionId = 'sgp' | 'nyc';

export interface RegionConfig {
  id: RegionId;
  label: string;
  host: string;
}

export const REGIONS: Record<RegionId, RegionConfig> = {
  sgp: { id: 'sgp', label: 'Singapore (APAC)',   host: 'sur-cards-times-census.trycloudflare.com' },
  nyc: { id: 'nyc', label: 'New York (Americas)', host: 'radios-fence-cpu-bedroom.trycloudflare.com' },
};

const LS_KEY = 'teambench_region_v1';

function readPersisted(): RegionId | null {
  try {
    const v = localStorage.getItem(LS_KEY);
    return (v === 'sgp' || v === 'nyc') ? v : null;
  } catch {
    return null;
  }
}

function writePersisted(r: RegionId) {
  try { localStorage.setItem(LS_KEY, r); } catch {}
}

function parseOverride(): RegionId | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('region');
    if (q === 'sgp' || q === 'nyc') return q;
  } catch {}
  return null;
}

/**
 * Race both backends; return the first region that responds to /api/sessions
 * within `timeoutMs`. Falls back to 'nyc' if neither responds.
 */
async function autoDetectRegion(timeoutMs = 2000): Promise<RegionId> {
  const probe = (r: RegionConfig): Promise<RegionId> => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(`https://${r.host}/api/sessions`, { signal: controller.signal })
      .then(() => { clearTimeout(t); return r.id; })
      .catch(() => { clearTimeout(t); return new Promise<RegionId>(() => {}); });
  };
  try {
    const winner = await Promise.race([
      probe(REGIONS.sgp),
      probe(REGIONS.nyc),
      new Promise<RegionId>(res => setTimeout(() => res('nyc'), timeoutMs + 500)),
    ]);
    return winner;
  } catch {
    return 'nyc';
  }
}

let cachedRegionPromise: Promise<RegionId> | null = null;

/**
 * Returns the currently-selected region. Prefers (1) URL override,
 * (2) localStorage cache, (3) first-time auto-detect. The auto-detect
 * is memoized so we only probe once per page load.
 */
export function getRegion(): Promise<RegionId> {
  const override = parseOverride();
  if (override) { writePersisted(override); return Promise.resolve(override); }
  const cached = readPersisted();
  if (cached) return Promise.resolve(cached);
  if (!cachedRegionPromise) {
    cachedRegionPromise = autoDetectRegion().then((r) => { writePersisted(r); return r; });
  }
  return cachedRegionPromise;
}

/** Synchronous best-guess host for immediate use. */
export function getHostSync(): string {
  const override = parseOverride();
  if (override) return REGIONS[override].host;
  const cached = readPersisted();
  if (cached) return REGIONS[cached].host;
  return REGIONS.sgp.host; // default before detection completes
}

/** Explicit switch. Clears current session state too. */
export function setRegion(r: RegionId) {
  writePersisted(r);
  cachedRegionPromise = Promise.resolve(r);
  // Force full reload so all URLs re-evaluate.
  window.location.reload();
}
