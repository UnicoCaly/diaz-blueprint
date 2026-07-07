/**
 * Parcel lookups by lon/lat against free, no-key county ArcGIS REST services.
 * Both endpoints were verified live (see project notes):
 *   - LA County Assessor parcels  -> real use codes, lot area in sq ft.
 *   - Orange County OCPW parcels   -> address + APN + year/beds only; lot area is
 *     computed from the polygon geometry (returned in State Plane US-feet).
 *
 * The US Census geocoder returns a point interpolated onto the STREET CENTERLINE,
 * which often lands in the road right-of-way between parcels — so an exact
 * point-in-polygon test misses. We try the exact point first, then fall back to a
 * small search buffer and disambiguate by house number when more than one parcel
 * is in range. Each function returns a normalized parcel object or null, and never
 * throws — any failure resolves to null so the orchestrator falls through to "look".
 */

const LA_PARCEL_LAYER =
  'https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/LACounty_Parcel/MapServer/0/query';

const OC_PARCEL_LAYER =
  'https://www.ocgis.com/arcpub/rest/services/Map_Layers/Parcels/MapServer/0/query';

const BUFFER_METERS = 14; // ~half a residential street width; enough to reach the fronting parcel

function str(v) {
  return v == null || String(v).trim() === '' ? null : String(v).trim();
}
function num(v) {
  return Number.isFinite(Number(v)) ? Number(v) : null;
}
function houseNoOf(s) {
  const m = String(s || '').match(/^\s*(\d+)/);
  return m ? m[1] : null;
}

// Run an ArcGIS point/buffer intersect; returns the features array ([] on miss/error).
async function queryFeatures(layer, lon, lat, outFields, returnGeometry, distance, timeoutMs) {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields,
    returnGeometry: returnGeometry ? 'true' : 'false',
    f: 'json',
  });
  if (distance) {
    params.set('distance', String(distance));
    params.set('units', 'esriSRUnit_Meter');
  }
  if (returnGeometry) params.set('outSR', '102646'); // State Plane US-ft -> shoelace gives sq ft

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${layer}?${params}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: 86400, cacheEverything: true }, // parcel data changes rarely
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data || data.error || !Array.isArray(data.features)) return []; // ArcGIS: 200 + {error}
    return data.features;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Exact point first; if nothing, buffer and pick the house-number match (else nearest/first).
async function resolveParcel(layer, lon, lat, { outFields, returnGeometry, houseNo, getNo, timeoutMs }) {
  let features = await queryFeatures(layer, lon, lat, outFields, returnGeometry, 0, timeoutMs);
  if (features.length === 0) {
    features = await queryFeatures(layer, lon, lat, outFields, returnGeometry, BUFFER_METERS, timeoutMs);
  }
  if (features.length === 0) return null;
  if (features.length === 1 || !houseNo) return features[0];
  const exact = features.find((f) => getNo(f.attributes) === houseNo);
  return exact || features[0];
}

/**
 * LA County Assessor parcel under a point.
 * @returns {Promise<null | {county:'LA', classification:string, lotSqft:number|null,
 *   hasDwelling:boolean, dataConfidence:'high', units:number|null, useType:string|null,
 *   useDesc:string|null, parcelAddress:string|null}>}
 */
export async function lookupLAParcel(lon, lat, opts = {}) {
  const { timeoutMs = 8000, houseNo = null } = opts;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  const feat = await resolveParcel(LA_PARCEL_LAYER, lon, lat, {
    outFields:
      'AIN,SitusHouseNo,SitusFullAddress,UseCode,UseCode_2,UseType,UseDescription,Units1,Shape.STArea()',
    returnGeometry: false,
    houseNo,
    getNo: (a) => str(a.SitusHouseNo),
    timeoutMs,
  });
  if (!feat || !feat.attributes) return null;

  const a = feat.attributes;
  const useType = str(a.UseType);
  const useCode2 = str(a.UseCode_2);
  const useDesc = str(a.UseDescription);
  const lotSqft = num(a['Shape.STArea()']); // verified: square feet
  const isResidential = (useType || '').toLowerCase() === 'residential';

  let classification = 'unknown';
  if ((useDesc || '').toUpperCase().includes('VACANT')) classification = 'vacant';
  else if (isResidential) {
    if (useCode2 === '01') classification = 'single_family';
    else if (['02', '03', '04', '05'].includes(useCode2 || '')) classification = 'multi_family';
    else classification = 'residential_other';
  } else if ((useType || '').toLowerCase() === 'commercial') classification = 'commercial';
  else if (useType) classification = 'other';

  return {
    county: 'LA',
    classification,
    lotSqft,
    hasDwelling: classification !== 'vacant',
    dataConfidence: 'high',
    units: num(a.Units1),
    useType,
    useDesc,
    parcelAddress: str(a.SitusFullAddress),
  };
}

// Shoelace area for ArcGIS polygon rings already in State Plane US-feet -> sq ft.
function ringsToSqft(geometry) {
  if (!geometry || !Array.isArray(geometry.rings)) return null;
  let total = 0;
  for (const ring of geometry.rings) {
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      a += x1 * y2 - x2 * y1;
    }
    total += a / 2; // signed: outer ring (+) and holes (-) cancel correctly
  }
  const sqft = Math.abs(total);
  return Number.isFinite(sqft) && sqft > 0 ? Math.round(sqft) : null;
}

/**
 * Orange County OCPW parcel under a point. No use code is published county-wide,
 * so land use is inferred from the bedroom/year signals and the verdict is hedged
 * downstream (dataConfidence: 'low').
 * @returns {Promise<null | {county:'OC', classification:string, lotSqft:number|null,
 *   hasDwelling:boolean, dataConfidence:'low', bedrooms:number|null,
 *   yearBuilt:string|null, parcelAddress:string|null}>}
 */
export async function lookupOCParcel(lon, lat, opts = {}) {
  const { timeoutMs = 6000, houseNo = null } = opts;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  const feat = await resolveParcel(OC_PARCEL_LAYER, lon, lat, {
    outFields: '*',
    returnGeometry: true,
    houseNo,
    getNo: (a) => houseNoOf(a.SITE_ADDRESS),
    timeoutMs,
  });
  if (!feat || !feat.attributes) return null;

  const a = feat.attributes;
  const bedrooms = num(a.NBR_BEDROOMS);
  const yearBuilt = str(a.YEAR_BUILT);
  const lotSqft = ringsToSqft(feat.geometry);
  const hasBeds = (bedrooms || 0) > 0;

  // The county-wide layer carries no use code, and NBR_BEDROOMS is often 0 even for
  // real homes — so don't gate residential on bedrooms alone. A built parcel of
  // residential size is treated as a (low-confidence) home; only clearly oversized
  // built parcels read as non-residential. The verdict is hedged downstream anyway.
  const RESIDENTIAL_MAX_SQFT = 20000; // ~0.46 acre; OC homes sit well under this
  let classification = 'unknown';
  let hasDwelling = false;
  if (hasBeds) {
    classification = 'single_family';
    hasDwelling = true;
  } else if (!yearBuilt) {
    classification = 'vacant';
  } else if (lotSqft != null && lotSqft <= RESIDENTIAL_MAX_SQFT) {
    classification = 'single_family'; // built + residential-sized -> likely a home
    hasDwelling = true;
  } else {
    classification = 'commercial'; // built but oversized -> likely non-residential
  }

  return {
    county: 'OC',
    classification,
    lotSqft,
    hasDwelling,
    dataConfidence: 'low',
    bedrooms,
    yearBuilt,
    parcelAddress: str(a.SITE_ADDRESS),
  };
}
