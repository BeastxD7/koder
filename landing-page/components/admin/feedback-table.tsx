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

export type AdminFeedbackRow = {
  id: string;
  user_id: string;
  email: string | null;
  rating: "up" | "down" | "retry";
  model: string | null;
  mode: string | null;
  chat_id: string | null;
  session_id: string | null;
  prompt_excerpt: string | null;
  response_excerpt: string | null;
  comment: string | null;
  expected: string | null;
  went_wrong: string | null;
  created_at: string;
};

function truncate(text: string | null | undefined, n = 80) {
  if (!text) return "—";
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

function RatingBadge({ rating }: { rating: AdminFeedbackRow["rating"] }) {
  if (rating === "up") return <Badge className="bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/20">up</Badge>;
  if (rating === "down") return <Badge variant="destructive">down</Badge>;
  return <Badge variant="secondary">retry</Badge>;
}

const columns: ColumnDef<AdminFeedbackRow>[] = [
  {
    accessorKey: "created_at",
    header: ({ column }) => (
      <Button variant="ghost" onClick={() => column.toggleSorting(column.getIsSorted() === "asc")} className="-ml-3">
        Time <ArrowUpDown className="ml-2 size-3.5" />
      </Button>
    ),
    cell: ({ row }) => <span className="text-muted-foreground whitespace-nowrap">{new Date(row.original.created_at).toLocaleString()}</span>,
  },
  {
    accessorKey: "rating",
    header: "Rating",
    cell: ({ row }) => <RatingBadge rating={row.original.rating} />,
  },
  {
    accessorKey: "email",
    header: "User",
    cell: ({ row }) => <span className="font-medium">{row.original.email ?? "—"}</span>,
  },
  {
    accessorKey: "model",
    header: "Model",
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.model ?? "—"}</span>,
  },
  {
    id: "prompt",
    header: "Prompt",
    cell: ({ row }) => <span className="text-muted-foreground" title={row.original.prompt_excerpt ?? ""}>{truncate(row.original.prompt_excerpt)}</span>,
  },
  {
    id: "response",
    header: "Response",
    cell: ({ row }) => <span className="text-muted-foreground" title={row.original.response_excerpt ?? ""}>{truncate(row.original.response_excerpt)}</span>,
  },
  {
    id: "note",
    header: "Note",
    cell: ({ row }) => {
      const note = row.original.comment || row.original.went_wrong || row.original.expected;
      return <span className="text-muted-foreground" title={note ?? ""}>{truncate(note)}</span>;
    },
  },
];

export function FeedbackTable({ data }: { data: AdminFeedbackRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "created_at", desc: true }]);
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
      const haystack = `${row.original.email ?? ""} ${row.original.model ?? ""} ${row.original.prompt_excerpt ?? ""}`.toLowerCase();
      return haystack.includes(needle);
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <Input
        placeholder="Search by email, model, or prompt…"
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
                  No feedback yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
