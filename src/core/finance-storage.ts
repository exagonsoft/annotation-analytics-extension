import { z } from 'zod';
import { db } from './storage';
import { batchName, normalizeFinancialTime, type FinancialDom, type FinancialMapping } from './finance';
import { redact } from './privacy';

export async function ingestFinancialTime(payload: unknown, url?: string): Promise<number> {
  const { payments, period } = normalizeFinancialTime(payload, url);
  return db.transaction('rw', db.payments, db.financialPeriods, async () => {
    const existing = await db.payments.bulkGet(payments.map(payment => payment.key));
    const writes = payments.filter((payment, index) => !existing[index]?.updatedAt || !!payment.updatedAt && existing[index]!.updatedAt! <= payment.updatedAt);
    await db.payments.bulkPut(writes);
    await db.financialPeriods.put(period);
    return writes.length;
  });
}
export const financialDomSchema = z.object({
  period: z.string().trim().min(1).max(500),
  rates: z.array(z.object({ name: z.string().trim().min(1).max(500), cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    unit: z.string().trim().min(1).max(50) })).max(100),
  rows: z.array(z.object({ engagement: z.string().max(500), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    status: z.string().trim().min(1).max(100), amountCents: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), tag: z.string().max(500) })).max(10_000),
});
export async function saveFinancialDom(value: unknown): Promise<FinancialDom> {
  const parsed = financialDomSchema.parse(redact(value));
  const snapshot: FinancialDom = { ...parsed, key: parsed.period, capturedAt: new Date().toISOString() };
  await db.financialDom.put(snapshot);
  return snapshot;
}
const mappingSchema = z.object({
  organizationId: z.string().min(1).max(200), engagementId: z.string().min(1).max(200), tag: z.string().min(1).max(500),
  batch: z.string().min(1).max(1000), dimension: z.enum(['iteration', 'project']), annotationScope: z.string().min(1).max(200),
  rateCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export async function saveFinancialMapping(value: Omit<FinancialMapping, 'key'>): Promise<void> {
  const parsed = mappingSchema.parse(value);
  await db.transaction('rw', db.financialMappings, async () => {
    const mappings = await db.financialMappings.toArray();
    if (mappings.some(mapping => mapping.dimension !== parsed.dimension)) {
      throw new Error('Use one mapping level (iteration or project), not both, to avoid overlapping annotation counts.');
    }
    const key = JSON.stringify([parsed.dimension, parsed.annotationScope]);
    const batchKey = (mapping: Omit<FinancialMapping, 'key'>) => JSON.stringify([mapping.organizationId, mapping.engagementId, mapping.tag, batchName(mapping.batch)]);
    if (mappings.some(mapping => mapping.key !== key && batchKey(mapping) === batchKey(parsed))) {
      throw new Error('This financial batch already has an annotation mapping. Use one complete annotation scope for each batch.');
    }
    await db.financialMappings.put({ ...parsed, key });
  });
}
export async function clearFinancialData(): Promise<void> {
  await db.transaction('rw', db.payments, db.financialPeriods, db.financialDom, db.financialMappings, async () => {
    await Promise.all([db.payments.clear(), db.financialPeriods.clear(), db.financialDom.clear(), db.financialMappings.clear()]);
  });
}
