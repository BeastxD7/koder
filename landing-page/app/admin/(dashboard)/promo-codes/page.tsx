import { dodoClient } from "../../../../lib/dodo";
import { PromoCodesTable, type PromoCodeRow } from "../../../../components/admin/promo-codes-table";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";

export const dynamic = "force-dynamic";

export default async function AdminPromoCodesPage() {
  let codes: PromoCodeRow[] = [];
  let loadError: string | null = null;

  try {
    // Percentage-only in Dodo (see actions.ts's createPromoCode) — amount
    // arrives in basis points (540 = 5.4%), converted for display here.
    for await (const d of dodoClient().discounts.list()) {
      codes.push({
        discount_id: d.discount_id,
        code: d.code,
        percent_off: d.amount / 100,
        expires_at: d.expires_at ?? null,
        usage_limit: d.usage_limit ?? null,
        times_used: d.times_used,
        created_at: d.created_at,
      });
    }
  } catch (err) {
    loadError = err instanceof Error ? err.message : "failed to load promo codes from Dodo";
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground">Promo codes</h1>
        <p className="text-sm text-muted-foreground">
          Percentage-off discount codes for LakshX Pro, managed directly through Dodo Payments (live mode).
        </p>
      </div>

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>All codes</CardTitle>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className="text-sm text-destructive">{loadError}</p>
          ) : (
            <PromoCodesTable data={codes} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
