import type { Metadata } from "next";
import type { ReactNode } from "react";
import LegalChrome from "../components/LegalChrome";

export const metadata: Metadata = {
  title: "Terms of Service — LakshX",
  description: "The terms that govern using LakshX — the IDE, the free hosted model, and bring-your-own-key providers.",
};

export default function TermsLayout({ children }: { children: ReactNode }) {
  return <LegalChrome>{children}</LegalChrome>;
}
