import type { Metadata } from "next";
import type { ReactNode } from "react";
import LegalChrome from "../components/LegalChrome";

export const metadata: Metadata = {
  title: "Privacy Policy — LakshX",
  description: "What LakshX actually collects, what it doesn't, and how the local-vs-cloud data boundary works.",
};

export default function PrivacyLayout({ children }: { children: ReactNode }) {
  return <LegalChrome>{children}</LegalChrome>;
}
