import type { Metadata } from "next";
import type { ReactNode } from "react";
import LegalChrome from "../components/LegalChrome";

export const metadata: Metadata = {
  title: "Refund Policy — LakshX",
  description: "How refunds work for LakshX subscriptions and usage-based credits.",
};

export default function RefundPolicyLayout({ children }: { children: ReactNode }) {
  return <LegalChrome>{children}</LegalChrome>;
}
