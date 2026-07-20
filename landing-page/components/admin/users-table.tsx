"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown, Eye, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { updateUserCredit, updateUserPlan } from "../../app/admin/actions";

export type AdminUserRow = {
  user_id: string;
  email: string | null;
  total_cost_usd: number;
  total_tokens_in: number;
  total_tokens_out: number;
  credit_limit_usd: number;
  last_used_at: string | null;
  plan: string;
  subscription_status: string | null;
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

/**
 * Auto-submits on change, same pattern as ModelPlansTable's PlanSelect
 * (components/admin/model-plans-table.tsx) — a two-value toggle reads
 * better as "pick a value, it's saved" than a form with a separate Save
 * button. Writes straight to user_subscription via updateUserPlan()
 * (app/admin/actions.ts), bypassing Dodo entirely — for comps, support
 * fixes, or unblocking someone while billing is misbehaving.
 */
function PlanSelect({ row }: { row: AdminUserRow }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  return (
    <form
      ref={formRef}
      action={async (formData) => {
        setStatus("saving");
        setErrorMsg(null);
        try {
          await updateUserPlan(formData);
          setStatus("saved");
          setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
        } catch (err) {
          setStatus("error");
          setErrorMsg(err instanceof Error ? err.message : "failed to save");
        }
      }}
      className="flex items-center gap-2"
    >
      <input type="hidden" name="userId" value={row.user_id} />
      <select
        name="plan"
        defaultValue={row.plan}
        onChange={() => formRef.current?.requestSubmit()}
        className="h-8 rounded-md border border-input bg-background px-2 text-sm capitalize"
      >
        <option value="free">Free</option>
        <option value="pro">Pro</option>
      </select>
      {status === "saving" && <span className="text-xs text-muted-foreground">Saving…</span>}
      {status === "saved" && <span className="text-xs text-emerald-600">Saved</span>}
      {status === "error" && <span className="text-xs text-destructive">{errorMsg}</span>}
    </form>
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
  {
    accessorKey: "plan",
    header: "Plan",
    cell: ({ row }) => <PlanSelect row={row.original} />,
  },
  {
    id: "actions",
    header: "",
    cell: ({ row }) => (
      <Button variant="ghost" size="icon" className="size-7" asChild>
        <Link href={`/admin/users/${row.original.user_id}`}>
          <Eye className="size-3.5" />
          <span className="sr-only">View user detail</span>
        </Link>
      </Button>
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
