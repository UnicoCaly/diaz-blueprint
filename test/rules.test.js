/**
 * Unit tests for the ADU rules engine. Run with:  node --test
 *
 * These guard two things: (1) the feasibility logic is right for each lot type,
 * and (2) the HONESTY + VOICE guardrails hold on every output the engine can
 * produce — no definitive verdicts, no guarantees, no banned/AVOID words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../shared/rules.js';

const VALID_VERDICTS = new Set(['yes', 'conditions', 'look']);

// Outward AVOID list (CLAUDE.md) — these words must never appear in client copy.
const AVOID_WORDS = [
  'industry-leading', 'best-in-class', 'cutting-edge', 'solutions', 'leverage',
  'synergy', 'luxury', 'premium', 'exclusive', 'act now', "don't miss out",
  'limited time',
];

// Honesty guardrail: the FIRM must never promise an approval or a definitive
// outcome it can't control. Note we ban the promissory collocations, NOT the bare
// word "guarantee" — "state law guarantees at least 800 sq ft" is an honest,
// factual statement about the statute and is allowed (and useful).
const OVERPROMISE_PHRASES = [
  'we guarantee', 'we promise', 'guaranteed approval', 'guaranteed permit',
  'guarantee your', 'approval guaranteed', 'definitely buildable',
  'will be approved', "we'll get it approved", 'promise you',
];

const BANNED = [...AVOID_WORDS, ...OVERPROMISE_PHRASES];

function allStrings(r) {
  const out = [r.headline, r.nextStep];
  for (const t of r.types || []) out.push(t.name, t.note);
  for (const c of r.costs || []) out.push(c.name, c.range, c.note);
  for (const n of r.notes || []) out.push(n);
  return out.filter(Boolean);
}

function assertGuardrails(r, label) {
  assert.ok(VALID_VERDICTS.has(r.verdict), `${label}: verdict must be yes|conditions|look, got ${r.verdict}`);
  assert.ok(r.headline && r.headline.length > 0, `${label}: needs a headline`);
  assert.ok(r.nextStep && r.nextStep.length > 0, `${label}: needs a nextStep`);
  const blob = allStrings(r).join(' · ').toLowerCase();
  for (const word of BANNED) {
    assert.ok(!blob.includes(word), `${label}: output contains banned/over-promising term "${word}"`);
  }
  assert.ok(!blob.includes('!'), `${label}: no exclamation marks in outward copy`);
  // The standing honesty disclaimer must ride along on every result.
  assert.ok(
    r.notes.some((n) => n.includes('not a permit')),
    `${label}: every result must carry the "not a permit" disclaimer`
  );
}

test('single-family in LA (high confidence) -> likely buildable', () => {
  const r = evaluate({ county: 'LA', classification: 'single_family', lotSqft: 5200, hasDwelling: true, dataConfidence: 'high' });
  assert.equal(r.verdict, 'yes');
  const names = r.types.map((t) => t.name).join('|');
  assert.match(names, /Detached ADU/);
  assert.match(names, /Junior ADU/);
  assert.ok(r.costs.length >= 1);
  assertGuardrails(r, 'LA SFR');
});

test('single-family in OC (low confidence) -> hedged to conditions', () => {
  const r = evaluate({ county: 'OC', classification: 'single_family', lotSqft: 6000, hasDwelling: true, dataConfidence: 'low' });
  assert.equal(r.verdict, 'conditions', 'OC has no use code, so the verdict must hedge');
  assert.match(r.headline, /Orange County/);
  assertGuardrails(r, 'OC SFR');
});

test('small single-family lot still buildable, with a small-lot note', () => {
  const r = evaluate({ county: 'LA', classification: 'single_family', lotSqft: 1800, hasDwelling: true, dataConfidence: 'high' });
  assert.equal(r.verdict, 'yes');
  assert.ok(r.notes.some((n) => /smaller side/i.test(n)), 'should add the small-lot guidance');
  assertGuardrails(r, 'small SFR');
});

test('multifamily -> conditions with conversion + detached options', () => {
  const r = evaluate({ county: 'LA', classification: 'multi_family', lotSqft: 9000, hasDwelling: true, dataConfidence: 'high', units: 6 });
  assert.equal(r.verdict, 'conditions');
  const names = r.types.map((t) => t.name).join('|');
  assert.match(names, /Convert non-livable space/);
  assert.match(names, /up to 8/i);
  assertGuardrails(r, 'MF');
});

test('commercial -> needs a closer look, never a denial', () => {
  const r = evaluate({ county: 'LA', classification: 'commercial', lotSqft: 12000, hasDwelling: true, dataConfidence: 'high' });
  assert.equal(r.verdict, 'look');
  assert.equal(r.types.length, 0, 'no ADU types asserted for non-residential');
  assertGuardrails(r, 'commercial');
});

test('vacant land -> closer look, encouraging (build home + ADU together)', () => {
  const r = evaluate({ county: 'LA', classification: 'vacant', lotSqft: 5000, hasDwelling: false, dataConfidence: 'high' });
  assert.equal(r.verdict, 'look');
  assert.match(r.headline, /vacant/i);
  assertGuardrails(r, 'vacant');
});

test('hasDwelling=false forces a closer look even if classed residential', () => {
  const r = evaluate({ county: 'LA', classification: 'single_family', lotSqft: 5000, hasDwelling: false, dataConfidence: 'high' });
  assert.equal(r.verdict, 'look');
  assertGuardrails(r, 'no-dwelling');
});

test('unknown classification -> closer look', () => {
  const r = evaluate({ county: 'OC', classification: 'unknown', lotSqft: null, hasDwelling: null, dataConfidence: 'low' });
  assert.equal(r.verdict, 'look');
  assertGuardrails(r, 'unknown');
});

test('empty / garbage input degrades safely to a closer look', () => {
  for (const bad of [undefined, null, {}, { classification: 'weird' }]) {
    const r = evaluate(bad);
    assert.ok(VALID_VERDICTS.has(r.verdict), 'always a valid verdict');
    assert.equal(r.verdict, 'look', 'unrecognized input must fall through to look');
    assertGuardrails(r, `garbage(${JSON.stringify(bad)})`);
  }
});
