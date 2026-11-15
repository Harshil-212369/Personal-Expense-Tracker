import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { AiGateway } from '../src/ai/gateway.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { openDatabase } from '../src/db/database.ts';
import type { Db } from '../src/db/database.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures/synthetic');

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURES, name)));
}

interface StatementTruth {
  periodStart: string;
  periodEnd: string;
  cardLast4: string;
  chargeCount: number;
  paymentCount: number;
  purchasesCents: number;
  creditsCents: number;
  paymentsCents: number;
}

export const expected = JSON.parse(readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8')) as {
  september: StatementTruth;
  october: StatementTruth;
  receipt: {
    purchasedOn: string; time: string; itemCount: number; subtotalCents: number; taxCents: number;
    totalCents: number; savingsCents: number; cardLast4: string; firstItem: string;
  };
};

export interface TestContext {
  app: Express;
  db: Db;
  config: Config;
}

/** A fresh app around an in-memory database: every test starts from an empty ledger. */
export function makeApp(options: { ai?: AiGateway | null; env?: Record<string, string> } = {}): TestContext {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', ...options.env });
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: { ...config, webDist: undefined }, ai: options.ai ?? null });
  return { app, db, config };
}

/** A stub gateway that records what it was asked, so tests can assert on exactly what would be sent. */
export function stubAi(overrides: Partial<AiGateway> = {}): AiGateway & { calls: { method: string; input: unknown }[] } {
  const calls: { method: string; input: unknown }[] = [];
  return {
    model: 'stub-model',
    calls,
    async categorizeMerchants(input) {
      calls.push({ method: 'categorizeMerchants', input });
      return overrides.categorizeMerchants ? overrides.categorizeMerchants(input) : [];
    },
    async extractStatement(input) {
      calls.push({ method: 'extractStatement', input });
      if (overrides.extractStatement) return overrides.extractStatement(input);
      throw new Error('extractStatement not stubbed');
    },
    async writeInsights(input) {
      calls.push({ method: 'writeInsights', input });
      return overrides.writeInsights ? overrides.writeInsights(input) : [];
    },
  };
}

/** A text PDF in a layout no built-in parser recognizes. */
export async function unknownLayoutPdf(lines: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  lines.forEach((line, i) => page.drawText(line, { x: 50, y: 740 - i * 16, size: 10, font }));
  return pdf.save();
}
