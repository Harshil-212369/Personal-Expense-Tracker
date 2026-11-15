import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPath, looksLikeCardNumber, luhnValid, scanText, shannonEntropy } from './privacy-guard.mjs';

// Test values are assembled at runtime so this file does not contain anything
// that looks like a real secret, to the guard or to any other scanner.
const join = (...parts) => parts.join('');
const rules = (text, denylist) => scanText(text, denylist).map((f) => f.rule);

describe('file type rules', () => {
  it('refuses financial documents, exports, databases, photos and key files', () => {
    for (const file of [
      'statement.pdf', 'inbox/receipt.eml', 'CIBC statements/October_eStatement.pdf', 'export.csv', 'budget.xlsx',
      'data/ledgerlens.db', 'data/ledgerlens.db-wal', 'receipt.jpg', 'IMG_1234.HEIC', 'backup.zip', 'server.pem', 'deploy.key',
    ]) {
      assert.ok(checkPath(file), `${file} should be refused`);
    }
  });

  it('refuses environment and credential files but not the example', () => {
    for (const file of ['.env', 'server/.env', '.env.local', '.env.production', 'id_rsa', '.ssh/id_ed25519.pub', 'credentials.json', 'client_secret_123.json', '.privacy-denylist', '.npmrc']) {
      assert.ok(checkPath(file), `${file} should be refused`);
    }
    assert.equal(checkPath('.env.example'), null);
  });

  it('allows source code and the synthetic fixture folders', () => {
    for (const file of [
      'server/src/app.ts', 'README.md', 'package-lock.json', 'web/public/favicon.svg',
      'server/test/fixtures/synthetic/statement-2026-10.pdf', 'server/test/fixtures/synthetic/metro-receipt.eml',
      'server/test/fixtures/synthetic/cibc-export-2026-10.csv', 'docs/screenshots/dashboard.png',
    ]) {
      assert.equal(checkPath(file), null, `${file} should be allowed`);
    }
  });

  it('does not let a fixture-looking name outside the allowlist through', () => {
    assert.ok(checkPath('server/test/fixtures/real/statement.pdf'));
    assert.ok(checkPath('docs/screenshots/nested/receipt.png'));
    assert.ok(checkPath('docs/synthetic-statement.pdf'));
  });
});

describe('secret patterns', () => {
  const cases = {
    'Anthropic API key': join('sk-', 'ant-', 'api03-', 'A1b2C3d4E5f6G7h8I9j0K1l2'),
    'GitHub token': join('gh', 'p_', 'a'.repeat(12), 'B7c8D9e0F1g2H3i4J5k6L7m8'),
    'AWS access key ID': join('AK', 'IA', 'IOSFODNN7EXAMPLQ'),
    'Google API key': join('AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
    'Slack token': join('xo', 'xb-', '123456789012-abcdefghijkl'),
    'private key block': join('-----BEGIN ', 'OPENSSH PRIVATE KEY-----'),
  };
  for (const [rule, secret] of Object.entries(cases)) {
    it(`finds a ${rule}`, () => {
      assert.deepEqual(rules(`const value = "${secret}";`), [rule]);
    });
  }

  it('finds a random-looking value assigned to a credential name', () => {
    const value = join('q7Zp', 'X2mK9', 'vL4tR8wN', '1cB6yH3j');
    assert.deepEqual(rules(`API_KEY="${value}"`), ['hard-coded credential']);
    assert.deepEqual(rules(`password: '${value}'`), ['hard-coded credential']);
  });

  it('ignores placeholders, descriptive values and references to variables', () => {
    for (const line of [
      'API_KEY="your-api-key-goes-here-xxxx"',
      "apiKey: 'example-key-for-documentation'",
      'password: "${{ secrets.DB_PASSWORD }}"',
      "const token = process.env['API_TOKEN'];",
      'ANTHROPIC_API_KEY=',
      'secret = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    ]) {
      assert.deepEqual(rules(line), [], line);
    }
  });

  it('never prints the secret it found', () => {
    const secret = cases['Anthropic API key'];
    const [finding] = scanText(`key = ${secret}`);
    assert.ok(!finding.preview.includes(secret.slice(6, -2)));
    assert.match(finding.preview, /^sk-a\*+..$/);
  });

  it('honours the inline allow comment', () => {
    assert.deepEqual(rules(`const fake = "${cases['GitHub token']}"; // privacy-guard: allow`), []);
  });
});

describe('personal identifiers', () => {
  // The industry-standard Visa test number (a 4 followed by fifteen 1s): Luhn-valid by design.
  const testCard = join('4111', '1111', '1111', '1111');

  it('validates check digits', () => {
    assert.equal(luhnValid(testCard), true);
    assert.equal(luhnValid(join('4111', '1111', '1111', '1112')), false);
    assert.equal(luhnValid(''), false);
  });

  it('flags a real-looking card number in any common spacing', () => {
    for (const shown of [testCard, testCard.match(/.{4}/g).join(' '), testCard.match(/.{4}/g).join('-')]) {
      assert.deepEqual(rules(`card ${shown} on file`), ['payment card number'], shown);
    }
  });

  it('does not flag masked numbers, bad check digits, timestamps or long IDs', () => {
    assert.equal(looksLikeCardNumber('4500 1234 5678 9013'), false); // fails the check digit
    for (const line of ['Card number XXXX XXXX XXXX 4242', '4500********4242', 'ts=1794734637919000', 'order 0000000000000000', 'pi = 3.14159265358979323846']) {
      assert.deepEqual(rules(line), [], line);
    }
  });

  it('flags a Canadian SIN but not a phone number', () => {
    assert.deepEqual(rules(join('SIN: 046', ' 454', ' 286')), ['Canadian SIN']);
    assert.deepEqual(rules('call 416-555-0142 or 1 800 465-4653'), []);
  });

  it('flags terms from the personal denylist, case-insensitively, in content', () => {
    const denylist = ['12 Example Crescent', 'M5V 2T6', 'ab'];
    assert.deepEqual(rules('ship to 12 EXAMPLE CRESCENT, Toronto m5v 2t6', denylist), ['personal denylist term', 'personal denylist term']);
    assert.deepEqual(rules('about a cab', denylist), [], 'terms under three characters are ignored');
  });
});

describe('entropy', () => {
  it('separates random strings from words', () => {
    assert.ok(shannonEntropy('q7ZpX2mK9vL4tR8wN1cB6yH3j') > 4);
    assert.ok(shannonEntropy('aaaaaaaaaaaaaaaaaaaa') < 1);
  });
});
