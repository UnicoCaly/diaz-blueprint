/**
 * POST /api/check — the Lot Check feasibility endpoint.
 *
 * Flow: address -> geocode (US Census) -> parcel (LA Assessor / OC OCPW) ->
 * rules engine (CA ADU law) -> a hedged, plain-English result card.
 *
 * Honesty guardrail (see README): every failure mode — bad geocode, out of area,
 * missing parcel, unusual record — falls through to a "Needs a Closer Look" card
 * with the phone path, NEVER an error page and NEVER a definitive yes/no.
 */
import { geocodeAddress } from '../../shared/geocode.js';
import { lookupLAParcel, lookupOCParcel } from '../../shared/parcels.js';
import { evaluate, lookResult } from '../../shared/rules.js';

export async function onRequestPost(context) {
  const { request } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, message: 'Invalid request.' }, 400);
  }

  const address = clean(body.address, 200);
  if (!address) return json({ ok: false, message: 'Please enter an address.' }, 400);

  // 1) Geocode.
  const geo = await geocodeAddress(address).catch(() => null);
  if (!geo) {
    return json(
      lookCard(address, '', [
        'We couldn’t pin down this address automatically — that happens with new builds, unusual records, or a small typo. It doesn’t mean you can’t build.',
      ])
    );
  }

  const county = normalizeCounty(geo); // 'LA' | 'OC' | null
  const countyDisplay = geo.county ? geo.county.replace(/\s*County$/i, '') : '';
  const matched = geo.matchedAddress || address;
  const houseNo = (matched.match(/^\s*(\d+)/) || [])[1] || null; // disambiguates buffered hits

  // 2) Coverage: we read county records automatically only for LA + OC.
  if (geo.state !== 'CA' || !county) {
    return json(
      lookCard(matched, countyDisplay, [
        'This address is outside Los Angeles and Orange Counties, where our Lot Check reads county records automatically. We still serve a wide area — let’s talk it through.',
      ])
    );
  }

  // 3) Parcel.
  const parcel =
    county === 'LA'
      ? await lookupLAParcel(geo.lon, geo.lat, { houseNo }).catch(() => null)
      : await lookupOCParcel(geo.lon, geo.lat, { houseNo }).catch(() => null);

  if (!parcel) {
    return json(
      lookCard(matched, countyDisplay, [
        'We found your address but couldn’t read the parcel record automatically just now. That’s common with newer parcels — and a look by hand is free.',
      ])
    );
  }

  // 4) Evaluate. The parcel object already carries the fields the engine needs.
  const r = evaluate(parcel);

  // 5) Shape the result card exactly as public/app.js renders it.
  return json({
    ok: true,
    verdict: r.verdict,
    matchedAddress: parcel.parcelAddress || matched,
    county: countyDisplay,
    headline: r.headline,
    facts: buildFacts(parcel),
    types: r.types,
    costs: r.costs,
    notes: r.notes,
    nextStep: r.nextStep,
  });
}

// LA = FIPS 06037, OC = 06059; fall back to the name if FIPS is missing.
function normalizeCounty(geo) {
  if (geo.countyFips5 === '06037') return 'LA';
  if (geo.countyFips5 === '06059') return 'OC';
  const name = (geo.county || '').toLowerCase();
  if (name.includes('los angeles')) return 'LA';
  if (name.includes('orange')) return 'OC';
  return null;
}

function buildFacts(parcel) {
  const facts = [];
  if (Number.isFinite(parcel.lotSqft)) {
    facts.push({
      num: Math.round(parcel.lotSqft).toLocaleString('en-US'),
      label: parcel.county === 'OC' ? 'sq ft lot (estimated)' : 'sq ft lot',
    });
  }
  const use = prettyUse(parcel);
  if (use) facts.push({ num: use, label: 'land use on file' });
  return facts;
}

const USE_LABELS = {
  single_family: 'Single-family',
  multi_family: 'Multi-family',
  residential_other: 'Residential',
  commercial: 'Commercial',
  vacant: 'Vacant',
};

function prettyUse(parcel) {
  if (parcel.county === 'OC') {
    // OC has no use code; report the residential signal honestly or stay silent.
    return parcel.hasDwelling ? 'Residential' : null;
  }
  return parcel.useDesc || USE_LABELS[parcel.classification] || null;
}

// A "Needs a Closer Look" card: no ADU verdict, just an honest explanation and the
// phone path. The rules engine owns the disclaimer + next-step copy; we pass the
// context-specific headline (notes[0]) and any extra notes through lookResult.
function lookCard(matchedAddress, county, notes) {
  const r = lookResult(notes[0], notes.slice(1));
  return {
    ok: true,
    verdict: 'look',
    matchedAddress,
    county,
    headline: r.headline,
    facts: [],
    types: [],
    costs: [],
    notes: r.notes,
    nextStep: r.nextStep,
  };
}

function clean(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
