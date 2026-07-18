"use client";

import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";

const chartConfig = {
  up_count: { label: "Thumbs up", color: "var(--color-chart-1)" },
  down_count: { label: "Thumbs down", color: "var(--color-chart-2)" },
  retry_count: { label: "Retry", color: "var(--color-chart-4)" },
} satisfies ChartConfig;

export type FeedbackSummaryRow = { day: string; up_count: number; down_count: number; retry_count: number };

export function FeedbackChart({ data }: { data: FeedbackSummaryRow[] }) {
  return (
    <Card className="bg-card">
      <CardHeader>
        <CardTitle>Ratings over time</CardTitle>
        <CardDescription>Daily thumbs up / down / retry from the IDE&apos;s review form, last {data.length} days with activity</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No feedback recorded yet.</p>
        ) : (
          <ChartContainer config={chartConfig} className="h-[240px] w-full">
            <BarChart data={data}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(value) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="up_count" stackId="ratings" fill="var(--color-up_count)" radius={[0, 0, 4, 4]} />
              <Bar dataKey="down_count" stackId="ratings" fill="var(--color-down_count)" />
              <Bar dataKey="retry_count" stackId="ratings" fill="var(--color-retry_count)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
