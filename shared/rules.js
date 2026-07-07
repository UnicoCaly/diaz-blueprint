/**
 * DBP Lot Check — ADU feasibility rules engine (pure, unit-testable).
 *
 * California STATEWIDE ADU law, Gov. Code §§66310–66342 (recodified by SB 477;
 * current as of 2026, incl. AB 1154 / SB 1211 / SB 543). State law is a FLOOR —
 * cities may be more permissive, never less. So statewide minimums are stated as
 * guaranteed; anything a city controls is hedged.
 *
 * HONESTY GUARDRAIL (do not remove — see README):
 *   - The verdict is always "likely". Never a definitive yes/no — an automated
 *     check can't see easements, fire zones, overlays, HOA rules, or the counter.
 *   - Anything unusual (commercial, vacant, unknown) falls through to "look"
 *     (Needs a Closer Look) + a human/phone path. Never an error, never a denial.
 *   - No promised approvals, no guarantees, no invented numbers.
 *
 * evaluate(facts) -> { verdict, headline, types, costs, notes, nextStep }
 *   in the exact shape public/app.js renders. `facts` is produced by check.js
 *   from county parcel data.
 */

export const ADU_RULES = {
  detached: {
    guaranteedMinSqft: 800, // §66321(b)(3) — city standards can't preclude this
    maxHeightFt: 16, // §66321(b)(4)(A)
    sideRearSetbackFt: 4, // §66321(b)(3)
    sizeFloorStudioOr1BR: 850, // §66321(b)(2)(A) — city cap can't go below
    sizeFloor2PlusBR: 1000, // §66321(b)(2)(B)
    commonLocalMaxSqft: 1200, // LOCAL-VARIABLE — common cap, not a state mandate
  },
  attached: {
    guaranteedMinSqft: 800, // §66321(b)(3)
    cityCapPctOfPrimary: 50, // LOCAL-VARIABLE cap, but never below 800 sqft
  },
  jadu: {
    maxSqft: 500, // §66333
    ownerOccupancyOnlyIfSharedBath: true, // AB 1154, eff. 2026
  },
  conversion: {
    noSetback: true, // §66323(a)(1)
    exemptFromLotLimits: true, // exempt from FAR / coverage / min-lot-size
  },
  multifamily: {
    conversionMinUnits: 1, // §66323(a)(3)
    conversionPctOfUnits: 25,
    detachedMaxExisting: 8, // §66323(a)(4), SB 1211 (was 2)
  },
  approval: { ministerial: true, reviewDays: 60 }, // §66317
};

const SHARED_DISCLAIMER =
  'This is an automated first look at public county records and California ADU law — not a permit or a final zoning decision. Your city sets the final rules at plan check.';

const ADU_TYPES = {
  detached: {
    name: 'Detached ADU',
    status: 'eligible',
    note: 'A standalone unit in the yard. State law guarantees at least 800 sq ft; many cities allow up to about 1,200.',
  },
  attached: {
    name: 'Attached ADU',
    status: 'eligible',
    note: 'Built onto your house. State law guarantees a real unit — a city’s size cap can’t force you below about 850 sq ft (1,000+ for two or more bedrooms), even on a smaller home.',
  },
  conversion: {
    name: 'Garage or space conversion',
    status: 'eligible',
    note: 'Convert an existing garage or part of the house. Usually the simplest path — no added setbacks, and no replacement parking required.',
  },
  jadu: {
    name: 'Junior ADU (JADU)',
    status: 'eligible',
    note: 'Up to 500 sq ft inside your home’s walls. Owner-occupancy only applies if it shares a bathroom with the main house.',
  },
  mfConversion: {
    name: 'Convert non-livable space',
    status: 'eligible',
    note: 'State law lets you turn storage, boiler rooms, or garages into at least one unit — up to 25% of your existing units.',
  },
  mfDetached: {
    name: 'Detached ADUs (up to 8)',
    status: 'eligible',
    note: 'On a lot with existing units, you can add up to eight detached ADUs, capped at your current unit count.',
  },
};

// Rough Southern California construction ballparks, 2026. Cost to BUILD (paid to a
// contractor) — separate from Diaz Blueprint’s plan-set fee (from $4,800, priced by project).
// Wide ranges on purpose: real cost swings with size, site, and finishes.
const ADU_COSTS = {
  conversion: { name: 'Garage / space conversion', range: '$100K–$200K', note: 'usually the lowest-cost path' },
  attached: { name: 'Attached ADU', range: '$150K–$300K' },
  detached: { name: 'Detached ADU', range: '$200K–$400K+', note: 'varies most with size and finishes' },
};

function result(verdict, { headline, types = [], costs = [], notes = [], nextStep }) {
  return { verdict, headline, types, costs, notes: [...notes, SHARED_DISCLAIMER], nextStep };
}

const NEXT_STEP = {
  yes:
    'Your next step is a permit-ready plan set — the part we handle, and we’re the firm that gets plans through, even the ones another designer couldn’t finish. Leave your name and number and Margarita’s team will call you back, in English or Spanish.',
  conditions:
    'Your next step is a quick look at the specifics for your lot and city, then a permit-ready plan set. Leave your name and number and Margarita’s team will call you back, in English or Spanish.',
  look:
    'Tell us your address and Margarita’s team will read the lot by hand — the way we have since 1990. Leave your number and we’ll call you back, in English or Spanish. No pressure either way.',
};

/**
 * Build a "Needs a Closer Look" result with a context-specific headline. Exported
 * so the orchestrator can produce geocode/coverage/parcel-miss cards that share
 * the engine's disclaimer and phone-path copy. (Keeps all copy in one place.)
 */
export function lookResult(headline, extraNotes = []) {
  return result('look', { headline, notes: extraNotes, nextStep: NEXT_STEP.look });
}

/**
 * @param {object} facts
 * @param {'LA'|'OC'|null} facts.county
 * @param {'single_family'|'multi_family'|'residential_other'|'commercial'|'vacant'|'other'|'unknown'} facts.classification
 * @param {number|null} facts.lotSqft
 * @param {boolean|null} facts.hasDwelling
 * @param {'high'|'low'} facts.dataConfidence   // OC has no use code -> 'low'
 * @param {number|null} [facts.units]
 */
export function evaluate(facts) {
  const f = facts || {};
  const cls = f.classification || 'unknown';
  const lotSqft = Number.isFinite(f.lotSqft) ? f.lotSqft : null;
  const lowConfidence = f.dataConfidence === 'low';

  // --- Non-residential: out of the residential ADU lane. Hand to a human. ---
  if (cls === 'commercial' || cls === 'other') {
    return lookResult(
      'County records show this parcel as non-residential, so the usual residential ADU rules don’t clearly apply. That doesn’t mean nothing can be done here — it means it’s worth a real look.',
      ['If this is actually a home and the records are out of date, tell us and we’ll read the lot ourselves.']
    );
  }

  // --- Vacant / no primary dwelling: ADUs are tied to a primary residence. ---
  if (cls === 'vacant' || f.hasDwelling === false) {
    return lookResult(
      'This looks like vacant land with no home on record. ADUs are tied to a primary residence — but you can often build a house and an ADU together, and that’s a plan worth drawing properly.',
      ['If there’s already a home here that the records are missing, let us know and we’ll take a closer look.']
    );
  }

  // --- Multifamily: a lot is possible, but the mix needs a real look. ---
  if (cls === 'multi_family') {
    return result('conditions', {
      headline:
        'You’re likely looking at a multi-unit property — and California now allows a lot here: converting non-livable space into units, plus up to eight detached ADUs (capped at your current unit count). The right mix takes a real look.',
      types: [ADU_TYPES.mfConversion, ADU_TYPES.mfDetached],
      costs: [ADU_COSTS.conversion, ADU_COSTS.detached],
      notes: ['On multifamily lots the conversion and detached allowances can stack, so there’s often more capacity than owners expect.'],
      nextStep: NEXT_STEP.conditions,
    });
  }

  // --- Unknown / unclassifiable residential: hedge to a human look. ---
  if (cls !== 'single_family' && cls !== 'residential_other') {
    return lookResult(
      'We couldn’t classify this lot cleanly from the county record. That happens with newer parcels and unusual records — and it doesn’t mean you can’t build.'
    );
  }

  // --- Single-family residential: the strong case. ---
  const types = [ADU_TYPES.detached, ADU_TYPES.attached, ADU_TYPES.conversion, ADU_TYPES.jadu];
  const costs = [ADU_COSTS.conversion, ADU_COSTS.attached, ADU_COSTS.detached];
  const notes = [];

  if (lotSqft != null && lotSqft < 2500) {
    notes.push(
      'Your lot is on the smaller side, so a garage conversion or a junior ADU is often the most realistic path — though the state’s guaranteed 800 sq ft detached unit is still protected.'
    );
  }
  notes.push(
    'A junior ADU may require you to live on-site only if it shares a bathroom with the main house (2026 rule).'
  );

  if (lowConfidence) {
    // Orange County: residential by the bedroom signal, but no use code to confirm.
    return result('conditions', {
      headline:
        'Your lot looks like a good candidate for an ADU. Orange County’s public records don’t confirm land use the way we’d like, so a quick human check makes the verdict solid.',
      types,
      costs,
      notes,
      nextStep: NEXT_STEP.conditions,
    });
  }

  return result('yes', {
    headline:
      'Good news — your lot looks like a strong candidate for an ADU. California’s statewide rules are on your side here.',
    types,
    costs,
    notes,
    nextStep: NEXT_STEP.yes,
  });
}
