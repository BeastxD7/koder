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
import { ArrowUpDown, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { updateUserCredit } from "../../app/admin/actions";

export type AdminUserRow = {
  user_id: string;
  email: string | null;
  total_cost_usd: number;
  total_tokens_in: number;
  total_tokens_out: number;
  credit_limit_usd: number;
  last_used_at: string | null;
};

function formatUsd(n: number | null | undefined) {
  return `$${Number(n ?? 0).toFixed(4)}`;
}

function EditCapDialog({ row }: { row: AdminUserRow }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null); // clear any stale error from a prior attempt when reopening
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7">
          <Pencil className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit credit cap</DialogTitle>
          <DialogDescription>{row.email}</DialogDescription>
        </DialogHeader>
        <form
          action={async (formData) => {
            setSaving(true);
            setError(null);
            try {
              await updateUserCredit(formData);
              setOpen(false);
            } catch (err) {
              setError(err instanceof Error ? err.message : "failed to save — try again");
            } finally {
              setSaving(false);
            }
          }}
          className="flex flex-col gap-4"
        >
          <input type="hidden" name="userId" value={row.user_id} />
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground">Cap ($)</label>
            <Input type="number" step="0.01" min="0" name="creditLimit" defaultValue={row.credit_limit_usd ?? 20} autoFocus />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const columns: ColumnDef<AdminUserRow>[] = [
  {
    accessorKey: "email",
    header: ({ column }) => (
      <Button variant="ghost" onClick={() => column.toggleSorting(column.getIsSorted() === "asc")} className="-ml-3">
        Email <ArrowUpDown className="ml-2 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => <span className="font-medium">{row.original.email}</span>,
  },
  {
    accessorKey: "total_cost_usd",
    header: ({ column }) => (
      <Button variant="ghost" onClick={() => column.toggleSorting(column.getIsSorted() === "asc")} className="-ml-3">
        Spent <ArrowUpDown className="ml-2 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => formatUsd(row.original.total_cost_usd),
  },
  {
    id: "tokens",
    header: "Tokens in/out",
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        {row.original.total_tokens_in ?? 0} / {row.original.total_tokens_out ?? 0}
      </span>
    ),
  },
  {
    accessorKey: "last_used_at",
    header: ({ column }) => (
      <Button variant="ghost" onClick={() => column.toggleSorting(column.getIsSorted() === "asc")} className="-ml-3">
        Last used <ArrowUpDown className="ml-2 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.last_used_at ? new Date(row.original.last_used_at).toLocaleString() : "—"}</span>
    ),
  },
  {
    accessorKey: "credit_limit_usd",
    header: "Cap",
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{formatUsd(row.original.credit_limit_usd)}</Badge>
        <EditCapDialog row={row.original} />
      </div>
    ),
  },
];

export function UsersTable({ data }: { data: AdminUserRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "total_cost_usd", desc: true }]);
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
    globalFilterFn: (row, _columnId, filterValue) => (row.original.email ?? "").toLowerCase().includes(String(filterValue).toLowerCase()),
  });

  return (
    <div className="flex flex-col gap-3">
      <Input
        placeholder="Search by email…"
        value={globalFilter}
        onChange={(e) => setGlobalFilter(e.target.value)}
        className="max-w-xs"
      />
      <div className="rounded-lg border border-border">
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
                  No users yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
