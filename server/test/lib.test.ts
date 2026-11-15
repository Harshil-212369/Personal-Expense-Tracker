import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { addDays, daysBetween, eachDay, isIsoDate, parseLongDate, resolveYear, toIsoDate, weekdayIndex } from '../src/lib/dates.ts';
import { safeEqual, sha256Hex } from '../src/lib/hash.ts';
import { merchantKey, normalizeMerchant } from '../src/lib/merchant.ts';
import { decimalToCents, formatCents, parseMoneyToCents } from '../src/lib/money.ts';

describe('money', () => {
  it('parses the formats statements print', () => {
    assert.equal(parseMoneyToCents('6.15'), 615);
    assert.equal(parseMoneyToCents('$1,234.56'), 123456);
    assert.equal(parseMoneyToCents('-41.85'), -4185);
    assert.equal(parseMoneyToCents('41.85-'), -4185);
    assert.equal(parseMoneyToCents('(12.00)'), -1200);
    assert.equal(parseMoneyToCents('$0.00'), 0);
    assert.equal(parseMoneyToCents('7'), 700);
    assert.equal(parseMoneyToCents('CAD$ 11.45'), 1145);
  });

  it('returns null rather than guessing', () => {
    for (const text of ['', 'abc', '22.99%', '1.234', '12,34.00', 'Sep 21', '$_____']) {
      assert.equal(parseMoneyToCents(text), null, text);
    }
  });

  it('converts decimals without float drift', () => {
    assert.equal(decimalToCents(1.15), 115);
    assert.equal(decimalToCents(19.99), 1999);
    assert.equal(decimalToCents(0.1 + 0.2), 30);
    assert.equal(decimalToCents(-41.85), -4185);
  });

  it('formats cents as dollars', () => {
    assert.equal(formatCents(123456), '$1,234.56');
    assert.equal(formatCents(-5), '-$0.05');
    assert.equal(formatCents(0), '$0.00');
  });
});

describe('dates', () => {
  it('validates calendar dates', () => {
    assert.equal(isIsoDate('2026-02-28'), true);
    assert.equal(isIsoDate('2026-02-30'), false);
    assert.equal(isIsoDate('2028-02-29'), true);
    assert.equal(isIsoDate('26-02-28'), false);
    assert.throws(() => toIsoDate(2026, 13, 1), RangeError);
  });

  it('does day arithmetic across month and year ends', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(daysBetween('2026-09-22', '2026-10-21'), 29);
    assert.deepEqual(eachDay('2026-02-27', '2026-03-01'), ['2026-02-27', '2026-02-28', '2026-03-01']);
    assert.equal(weekdayIndex('2026-11-09'), 0); // a Monday
    assert.equal(weekdayIndex('2026-11-15'), 6); // a Sunday
  });

  it('places year-less statement rows using the period end', () => {
    assert.equal(resolveYear(10, 5, '2026-10-21'), '2026-10-05');
    assert.equal(resolveYear(9, 21, '2026-10-21'), '2026-09-21');
    // A December purchase on a statement that closes in January belongs to the previous year.
    assert.equal(resolveYear(12, 28, '2027-01-21'), '2026-12-28');
    // Posting a few days after the period closes is still this year.
    assert.equal(resolveYear(1, 23, '2027-01-21'), '2027-01-23');
  });

  it('parses long dates', () => {
    assert.equal(parseLongDate('October 21, 2026'), '2026-10-21');
    assert.equal(parseLongDate('Statement ends Sep 3, 2026.'), '2026-09-03');
    assert.equal(parseLongDate('Smarch 3, 2026'), null);
    assert.equal(parseLongDate('nothing here'), null);
  });
});

describe('merchant normalization', () => {
  const cases: Array<[string, string]> = [
    ['TIM HORTONS #1021', 'Tim Hortons'],
    ['STARBUCKS COFFEE #8051', 'Starbucks'],
    ['PRESTO MOBI/SQFH8DMVBP', 'PRESTO'],
    ['PRESTO UNION STN', 'PRESTO'],
    ['WAL-MART STORE#1099', 'Walmart'],
    ["NOFRILLS SAM'S #3101", 'No Frills'],
    ['SQ *NOODLE HOUSE', 'Noodle House'],
    ['ANTHROPIC* CLAUDE SUB', 'Anthropic'],
    ['GOOGLE*GOOGLE ONE', 'Google One'],
    ['Lyft *Temp Auth Hold', 'Lyft'],
    ['UBER CANADA/UBEREATS', 'Uber Eats'],
    ['Spotify P1A2B3C4D5', 'Spotify'],
    ['Spotify PABCDEFGHJ', 'Spotify'],
    ['NETFLIX.COM', 'Netflix'],
    ['SQ *PAPERSHOP.CA', 'Papershop'],
    ['FIDO MOBILE ******1234', 'Fido Mobile'],
    ['CAMPUS EATS-20411', 'Campus Eats'],
    ['SHELL C01234', 'Shell'],
    ['METRO 9001', 'Metro'],
    ['IKEA TORONTO DOWNTOWN 100', 'IKEA'],
    ["MCDONALD'S #40437", "McDonald's"],
    ['SQ *CORNER BOOK SOCIETY C', 'Corner Book Society'],
    ['   ', 'Unknown'],
  ];
  for (const [raw, clean] of cases) {
    it(`"${raw}" -> "${clean}"`, () => assert.equal(normalizeMerchant(raw), clean));
  }

  it('gives one name to every store of a chain', () => {
    const names = new Set(['DOLLARAMA #1201', 'DOLLARAMA #0985', 'DOLLARAMA # 880'].map(normalizeMerchant));
    assert.deepEqual([...names], ['Dollarama']);
  });

  it('builds comparison keys', () => {
    assert.equal(merchantKey("NoFrills Sam's #3101"), 'nofrillssams3101');
  });
});

describe('hash', () => {
  it('hashes deterministically and compares in constant time', () => {
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(safeEqual('token-a', 'token-a'), true);
    assert.equal(safeEqual('token-a', 'token-b'), false);
    assert.equal(safeEqual('short', 'a much longer value'), false);
  });
});

describe('config', () => {
  const base = { NODE_ENV: 'test' };

  it('defaults to loopback with AI and auth off', () => {
    const config = loadConfig(base);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.apiToken, undefined);
    assert.equal(config.anthropicApiKey, undefined);
    assert.equal(config.anthropicModel, 'claude-opus-5-5');
  });

  it('treats blank values as unset', () => {
    const config = loadConfig({ ...base, API_TOKEN: '  ', ANTHROPIC_API_KEY: '' });
    assert.equal(config.apiToken, undefined);
    assert.equal(config.anthropicApiKey, undefined);
  });

  it('refuses to listen beyond loopback without a token', () => {
    assert.throws(() => loadConfig({ ...base, HOST: '0.0.0.0' }), /without API_TOKEN/);
    assert.doesNotThrow(() => loadConfig({ ...base, HOST: '0.0.0.0', API_TOKEN: 'x'.repeat(32) }));
  });

  it('rejects weak tokens and malformed values', () => {
    assert.throws(() => loadConfig({ ...base, API_TOKEN: 'short' }), /at least 24/);
    assert.throws(() => loadConfig({ ...base, PORT: 'not-a-port' }), /Invalid environment/);
  });

  it('parses redaction terms, ignoring ones too short to be safe', () => {
    assert.deepEqual(loadConfig({ ...base, REDACT_TERMS: 'Alex Sample, 12 Example St, ab' }).redactTerms, ['Alex Sample', '12 Example St']);
  });
});
