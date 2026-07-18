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
import { ArrowUpDown, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

export type AdminErrorReportRow = {
  id: string;
  user_id: string;
  email: string | null;
  error_message: string;
  diagnostic_report: string | null;
  model: string | null;
  mode: string | null;
  created_at: string;
};

function truncate(text: string | null | undefined, n = 80) {
  if (!text) return "—";
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

function ViewReportSheet({ row }: { row: AdminErrorReportRow }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7">
          <FileText className="size-3.5" />
          <span className="sr-only">View full report</span>
        </Button>
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col gap-0 data-[side=right]:sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Error report</SheetTitle>
          <SheetDescription>
            {row.email ?? "unknown user"} · {new Date(row.created_at).toLocaleString()}
            {row.model && ` · ${row.model}`}
            {row.mode && ` · ${row.mode}`}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Error message</span>
            <pre className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground">
              {row.error_message}
            </pre>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1.5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Diagnostic report</span>
            {row.diagnostic_report ? (
              <pre className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-xs text-foreground">
                {row.diagnostic_report}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">No diagnostic report was attached to this submission.</p>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

const columns: ColumnDef<AdminErrorReportRow>[] = [
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
    accessorKey: "mode",
    header: "Mode",
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.mode ?? "—"}</span>,
  },
  {
    id: "error_message",
    header: "Error",
    cell: ({ row }) => <span className="text-muted-foreground" title={row.original.error_message}>{truncate(row.original.error_message, 100)}</span>,
  },
  {
    id: "actions",
    header: "",
    cell: ({ row }) => <ViewReportSheet row={row.original} />,
  },
];

export function ErrorReportsTable({ data }: { data: AdminErrorReportRow[] }) {
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
      const haystack = `${row.original.email ?? ""} ${row.original.model ?? ""} ${row.original.error_message}`.toLowerCase();
      return haystack.includes(needle);
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <Input
        placeholder="Search by email, model, or error…"
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
                  No error reports yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
