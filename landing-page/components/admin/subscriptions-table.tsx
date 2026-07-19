"use client";

import { useState } from "react";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export type AdminSubscriptionRow = {
  user_id: string;
  email: string | null;
  dodo_customer_id: string | null;
  dodo_subscription_id: string | null;
  plan: string;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  updated_at: string;
};

// Mirrors Dodo's SubscriptionStatus enum (pending/active/on_hold/cancelled/
// failed/expired) — see schema.sql's user_subscription.status check
// constraint, which accepts exactly these values.
const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  pending: "secondary",
  on_hold: "destructive",
  cancelled: "outline",
  failed: "destructive",
  expired: "outline",
};

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const columns: ColumnDef<AdminSubscriptionRow>[] = [
  {
    accessorKey: "updated_at",
    header: ({ column }) => (
      <Button variant="ghost" onClick={() => column.toggleSorting(column.getIsSorted() === "asc")} className="-ml-3">
        Updated <ArrowUpDown className="ml-2 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => <span className="text-muted-foreground whitespace-nowrap">{new Date(row.original.updated_at).toLocaleString()}</span>,
  },
  {
    accessorKey: "email",
    header: "User",
    cell: ({ row }) => <span className="font-medium">{row.original.email ?? "—"}</span>,
  },
  {
    accessorKey: "plan",
    header: "Plan",
    cell: ({ row }) => <span className="capitalize">{row.original.plan}</span>,
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <Badge variant={STATUS_VARIANT[row.original.status] ?? "outline"} className="capitalize">
        {row.original.status.replace("_", " ")}
      </Badge>
    ),
  },
  {
    accessorKey: "current_period_start",
    header: "Period start",
    cell: ({ row }) => <span className="text-muted-foreground whitespace-nowrap">{formatDate(row.original.current_period_start)}</span>,
  },
  {
    accessorKey: "current_period_end",
    header: "Period end",
    cell: ({ row }) => <span className="text-muted-foreground whitespace-nowrap">{formatDate(row.original.current_period_end)}</span>,
  },
  {
    id: "dodo_subscription_id",
    header: "Dodo subscription",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground" title={row.original.dodo_subscription_id ?? undefined}>
        {row.original.dodo_subscription_id ?? "—"}
      </span>
    ),
  },
];

export function SubscriptionsTable({ data }: { data: AdminSubscriptionRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "updated_at", desc: true }]);
  const [globalFilter, setGlobalFilter] = useState("");

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: (row, _columnId, filterValue) => {
      const needle = String(filterValue).toLowerCase();
      const haystack = `${row.original.email ?? ""} ${row.original.plan} ${row.original.status} ${row.original.dodo_subscription_id ?? ""}`.toLowerCase();
      return haystack.includes(needle);
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <Input
        placeholder="Search by email, plan, or status…"
        value={globalFilter}
        onChange={(e) => setGlobalFilter(e.target.value)}
        className="max-w-xs"
      />
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
                  No subscriptions yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
