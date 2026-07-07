/**
 * Address -> coordinates + county, via the FREE US Census Geocoder (no API key).
 * One call to geographies/onelineaddress returns the matched address, lon/lat,
 * and the county/state. Verified live against the Public_AR_Current benchmark.
 */

const CENSUS_URL =
  'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';

/**
 * @param {string} address
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=8000]
 * @returns {Promise<null | {
 *   matchedAddress: string|null, lon: number, lat: number,
 *   county: string|null, countyFips5: string|null, state: string|null
 * }>}
 */
export async function geocodeAddress(address, opts = {}) {
  const { timeoutMs = 8000 } = opts;
  if (typeof address !== 'string' || address.trim() === '') return null;

  const params = new URLSearchParams({
    address: address.trim(),
    benchmark: 'Public_AR_Current',
    vintage: 'Current_Current',
    format: 'json',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let data;
  try {
    const resp = await fetch(`${CENSUS_URL}?${params}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'dbp-lotcheck/1.0' },
    });
    if (!resp || !resp.ok) return null;
    data = await resp.json();
  } catch {
    return null; // network error or timeout
  } finally {
    clearTimeout(timer);
  }

  // No-match returns HTTP 200 with an empty addressMatches array.
  const matches = data && data.result && data.result.addressMatches;
  if (!Array.isArray(matches) || matches.length === 0) return null;

  const m = matches[0];
  const lon = Number(m && m.coordinates && m.coordinates.x);
  const lat = Number(m && m.coordinates && m.coordinates.y);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  const counties = m.geographies && m.geographies.Counties;
  const county = Array.isArray(counties) ? counties[0] : null;

  return {
    matchedAddress: m.matchedAddress || null,
    lon,
    lat,
    county: (county && county.NAME) || null, // e.g. "Los Angeles County"
    countyFips5:
      (county && (county.GEOID || (county.STATE && county.COUNTY && county.STATE + county.COUNTY))) || null,
    state:
      (m.addressComponents && m.addressComponents.state) ||
      (m.geographies && m.geographies.States && m.geographies.States[0] && m.geographies.States[0].STUSAB) ||
      null,
  };
}
