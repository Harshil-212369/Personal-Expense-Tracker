import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { HttpError } from '../lib/errors.ts';

/**
 * Everything the app asks of an LLM goes through this interface. The rest of
 * the code depends on the interface only, which is what lets the test suite
 * (and CI) run with a stub and no API key.
 *
 * Design rule: the model does perception (reading messy text, naming a
 * category, phrasing an observation). Code does all arithmetic and every
 * decision about what gets stored. Model output is treated as untrusted input
 * and validated before use.
 */
export interface AiGateway {
  readonly model: string;
  categorizeMerchants(input: { merchants: string[]; categories: string[] }): Promise<MerchantCategory[]>;
  extractStatement(minimizedText: string): Promise<AiStatement>;
  writeInsights(rollup: unknown): Promise<AiInsight[]>;
}

export interface MerchantCategory {
  merchant: string;
  category: string;
  confidence: 'high' | 'medium' | 'low';
}

export const AiStatementSchema = z.object({
  institution: z.string().describe('Bank or card issuer name, or "Unknown".'),
  accountLast4: z.string().nullable().describe('Last four digits of the account if printed, else null.'),
  periodStart: z.string().nullable().describe('Statement period start as YYYY-MM-DD, or null.'),
  periodEnd: z.string().nullable().describe('Statement period end as YYYY-MM-DD, or null.'),
  statedTotals: z.object({
    purchases: z.number().nullable().describe('Total purchases/charges printed on the statement, in dollars.'),
    payments: z.number().nullable().describe('Total payments printed on the statement, in dollars.'),
    credits: z.number().nullable().describe('Total refunds/credits printed on the statement, in dollars.'),
  }),
  transactions: z.array(
    z.object({
      date: z.string().describe('Transaction date as YYYY-MM-DD.'),
      description: z.string().describe('Merchant text exactly as printed, without city or province.'),
      amount: z.number().describe('Dollars. Positive for a charge, negative for a refund, credit or payment.'),
      kind: z.enum(['purchase', 'refund', 'payment', 'credit', 'fee', 'interest']),
    }),
  ),
});
export type AiStatement = z.infer<typeof AiStatementSchema>;

const AiInsightSchema = z.object({
  insights: z.array(
    z.object({
      tone: z.enum(['neutral', 'up', 'down', 'alert']),
      title: z.string(),
      detail: z.string(),
    }),
  ),
});
export type AiInsight = z.infer<typeof AiInsightSchema>['insights'][number];

/** Models that accept the server-side refusal fallback parameter. */
function supportsServerFallback(model: string): boolean {
  return /^claude-(?:opus-5|fable-5|sonnet-5-5)/.test(model);
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new HttpError(503, 'ai-auth', 'The AI provider rejected the configured API key.');
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new HttpError(503, 'ai-rate-limited', 'The AI provider is rate limiting requests. Try again shortly.');
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new HttpError(503, 'ai-unreachable', 'Could not reach the AI provider.');
  }
  if (error instanceof Anthropic.APIError) {
    return new HttpError(502, 'ai-error', `The AI provider returned an error (HTTP ${error.status ?? 'unknown'}).`);
  }
  return new HttpError(502, 'ai-error', 'The AI request failed.');
}

export function createAnthropicGateway(
  config: Pick<Config, 'anthropicApiKey' | 'anthropicModel'>,
  /** Test seam: lets the suite answer API calls locally instead of over the network. */
  overrides: { fetch?: typeof fetch; maxRetries?: number } = {},
): AiGateway | null {
  if (!config.anthropicApiKey) return null;
  const client = new Anthropic({
    apiKey: config.anthropicApiKey,
    maxRetries: overrides.maxRetries ?? 2,
    timeout: 120_000,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
  });
  const model = config.anthropicModel;

  async function ask<Schema extends z.ZodType>(options: {
    schema: Schema;
    system: string;
    user: string;
    effort: 'low' | 'medium';
    maxTokens: number;
  }): Promise<z.infer<Schema>> {
    let response;
    try {
      response = await client.beta.messages.create({
        model,
        max_tokens: options.maxTokens,
        system: options.system,
        messages: [{ role: 'user', content: options.user }],
        output_config: { effort: options.effort, format: betaZodOutputFormat(options.schema) },
        // If a safety classifier declines the request, let the API re-run it on
        // its default fallback model instead of failing the import.
        ...(supportsServerFallback(model)
          ? { betas: ['server-side-fallback-2026-07-01' as const], fallbacks: 'default' as const }
          : {}),
      });
    } catch (error) {
      throw toHttpError(error);
    }

    // Check why the model stopped before reading anything it wrote.
    if (response.stop_reason === 'refusal') {
      throw new HttpError(502, 'ai-refused', 'The AI model declined this request.');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new HttpError(502, 'ai-incomplete', 'The AI response was cut off. Try a smaller document.');
    }
    const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new HttpError(502, 'ai-invalid', 'The AI response was not valid JSON.');
    }
    // The schema is enforced by the API, and checked again here: nothing the
    // model returns is used without passing local validation.
    const validated = options.schema.safeParse(json);
    if (!validated.success) {
      throw new HttpError(502, 'ai-invalid', 'The AI response did not match the expected shape.');
    }
    return validated.data;
  }

  return {
    model,

    async categorizeMerchants({ merchants, categories }) {
      const schema = z.object({
        assignments: z.array(
          z.object({
            merchant: z.string(),
            // The enum is built from the live category list, so the model
            // cannot invent a category that does not exist.
            category: z.enum(categories as [string, ...string[]]),
            confidence: z.enum(['high', 'medium', 'low']),
          }),
        ),
      });
      const result = await ask({
        schema,
        effort: 'low',
        maxTokens: 8000,
        system:
          'You categorize merchant names from Canadian card statements for a personal budgeting app. ' +
          'Return exactly one assignment per merchant, copying the merchant string verbatim. ' +
          'Choose the category a person would expect to see that merchant under. ' +
          'Use "Other" with low confidence when the name does not identify the kind of business.',
        user: `Merchants:\n${merchants.map((m) => `- ${m}`).join('\n')}`,
      });
      return result.assignments;
    },

    async extractStatement(minimizedText) {
      return ask({
        schema: AiStatementSchema,
        effort: 'medium',
        maxTokens: 32000,
        system:
          'You extract transactions from the text layer of a bank or credit card statement. ' +
          'The text has been reduced to transaction-like lines and identifiers are masked with tags such as [CARD]. ' +
          'Extract every transaction exactly once, in document order. Copy descriptions as printed. ' +
          'Infer the year of each row from the statement period. ' +
          'Report the totals the statement prints; use null for any total that is not printed. Do not compute totals yourself.',
        user: `Statement text:\n\n${minimizedText}`,
      });
    },

    async writeInsights(rollup) {
      const result = await ask({
        schema: AiInsightSchema,
        effort: 'medium',
        maxTokens: 8000,
        system:
          'You are a careful personal-finance analyst. You receive aggregate spending figures (already computed; amounts are in cents) ' +
          'and write three to five observations the person would not see at a glance. ' +
          'Each observation needs a short title and one or two sentences that cite specific figures from the data, formatted as dollars. ' +
          'Only state what the figures support. Do not give investment advice and do not moralize about spending. ' +
          'tone: "up" when spending rose, "down" when it fell, "alert" for something worth checking, otherwise "neutral".',
        user: JSON.stringify(rollup),
      });
      return result.insights.slice(0, 5);
    },
  };
}
