"use client";

import { useState } from "react";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { createPromoCode, deletePromoCode } from "../../app/admin/actions";

export type PromoCodeRow = {
  discount_id: string;
  code: string;
  percent_off: number;
  expires_at: string | null;
  usage_limit: number | null;
  times_used: number;
  created_at: string;
};

function CreatePromoCodeDialog() {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-3.5" />
          New code
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New promo code</DialogTitle>
          <DialogDescription>Percentage off LakshX Pro. Leave code blank for a random one.</DialogDescription>
        </DialogHeader>
        <form
          action={async (formData) => {
            setSaving(true);
            setError(null);
            try {
              await createPromoCode(formData);
              setOpen(false);
            } catch (err) {
              setError(err instanceof Error ? err.message : "failed to create — try again");
            } finally {
              setSaving(false);
            }
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground">Code (optional)</label>
            <Input name="code" placeholder="LAUNCH20" maxLength={16} autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground">Percent off</label>
            <Input type="number" step="0.1" min="1" max="100" name="percentOff" placeholder="20" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground">Expires (optional)</label>
            <Input type="date" name="expiresAt" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground">Usage limit (optional)</label>
            <Input type="number" step="1" min="1" name="usageLimit" placeholder="Unlimited" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeletePromoCodeButton({ discountId }: { discountId: string }) {
  const [deleting, setDeleting] = useState(false);

  return (
    <form
      action={async (formData) => {
        if (!confirm("Delete this promo code? This can't be undone.")) return;
        setDeleting(true);
        try {
          await deletePromoCode(formData);
        } finally {
          setDeleting(false);
        }
      }}
    >
      <input type="hidden" name="discountId" value={discountId} />
      <Button type="submit" variant="ghost" size="icon" className="size-7" disabled={deleting}>
        <Trash2 className="size-3.5" />
        <span className="sr-only">Delete</span>
      </Button>
    </form>
  );
}

function formatDate(iso: string | null) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const columns: ColumnDef<PromoCodeRow>[] = [
  {
    accessorKey: "code",
    header: ({ column }) => (
      <Button variant="ghost" onClick={() => column.toggleSorting(column.getIsSorted() === "asc")} className="-ml-3">
        Code <ArrowUpDown className="ml-2 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => <span className="font-mono font-medium">{row.original.code}</span>,
  },
  {
    accessorKey: "percent_off",
    header: "Discount",
    cell: ({ row }) => `${row.original.percent_off}% off`,
  },
  {
    accessorKey: "times_used",
    header: "Used",
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        {row.original.times_used}
        {row.original.usage_limit ? ` / ${row.original.usage_limit}` : ""}
      </span>
    ),
  },
  {
    accessorKey: "expires_at",
    header: "Expires",
    cell: ({ row }) => <span className="text-muted-foreground whitespace-nowrap">{formatDate(row.original.expires_at)}</span>,
  },
  {
    accessorKey: "created_at",
    header: ({ column }) => (
      <Button variant="ghost" onClick={() => column.toggleSorting(column.getIsSorted() === "asc")} className="-ml-3">
        Created <ArrowUpDown className="ml-2 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => <span className="text-muted-foreground whitespace-nowrap">{formatDate(row.original.created_at)}</span>,
  },
  {
    id: "actions",
    header: "",
    cell: ({ row }) => <DeletePromoCodeButton discountId={row.original.discount_id} />,
  },
];

export function PromoCodesTable({ data }: { data: PromoCodeRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "created_at", desc: true }]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <CreatePromoCodeDialog />
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}</TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  No promo codes yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
