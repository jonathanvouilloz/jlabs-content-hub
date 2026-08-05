import { createHash } from "node:crypto";

const LEGACY_RAW_TOKEN = /^[a-f0-9]{48}$/;
const STORED_V1 = /^v1:[a-f0-9]{64}$/;
const STORED_V2 = /^v2:\d+:[a-f0-9]{64}$/;

export type ClientTokenBackfillRow = {
  id: string;
  slug: string;
  stored: string;
};

export type ClientTokenBackfillPlan = {
  updates: Array<ClientTokenBackfillRow & { previous: string; next: string }>;
  unchanged: string[];
  blocked: Array<{ id: string; slug: string; reason: "unknown_format" }>;
};

export function planClientTokenBackfill(
  rows: readonly ClientTokenBackfillRow[],
): ClientTokenBackfillPlan {
  const plan: ClientTokenBackfillPlan = {
    updates: [],
    unchanged: [],
    blocked: [],
  };
  for (const row of rows) {
    if (STORED_V1.test(row.stored) || STORED_V2.test(row.stored)) {
      plan.unchanged.push(row.slug);
      continue;
    }
    if (!LEGACY_RAW_TOKEN.test(row.stored)) {
      plan.blocked.push({
        id: row.id,
        slug: row.slug,
        reason: "unknown_format",
      });
      continue;
    }
    const digest = createHash("sha256").update(row.stored).digest("hex");
    plan.updates.push({ ...row, previous: row.stored, next: `v1:${digest}` });
  }
  return plan;
}
