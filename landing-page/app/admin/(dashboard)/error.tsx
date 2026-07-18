"use client";

import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";

export default function AdminDashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card className="border-destructive/40 bg-card">
      <CardHeader>
        <CardTitle className="text-destructive">Something went wrong</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{error.message || "An unexpected error occurred loading this page."}</p>
        <Button variant="secondary" className="w-fit" onClick={() => reset()}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}
