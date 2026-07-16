import type { Metadata } from "next";
import type { ReactNode } from "react";
import ChangelogChrome from "./_components/ChangelogChrome";

export const metadata: Metadata = {
  title: "Changelog — LakshX",
  description:
    "What shipped in LakshX, day by day — generated from the project's real commit history, grouped by date and rough area (agent, databases, docs, build & distribution, UI).",
};

export default function ChangelogLayout({ children }: { children: ReactNode }) {
  return <ChangelogChrome>{children}</ChangelogChrome>;
}
