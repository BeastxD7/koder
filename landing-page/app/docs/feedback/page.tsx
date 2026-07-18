import type { Metadata } from "next";
import Link from "next/link";
import DocArticle from "../_components/DocArticle";
import DocHeader, { AccessRow } from "../_components/DocHeader";
import Callout from "../_components/Callout";
import CodeBlock from "../_components/CodeBlock";

export const metadata: Metadata = {
  title: "Feedback & Diagnostics",
  description: "Thumbs, retry, the error Report button, and the full diagnostic report in the LakshX chat.",
};

export default function FeedbackPage() {
  return (
    <DocArticle>
      <DocHeader eyebrow="Chat & Agent" title="Feedback & Diagnostics">
        A handful of small tools in the chat make each answer better and help you report problems: rate a
        response, retry it, report an error, or copy a full diagnostic report.
      </DocHeader>

      <AccessRow
        items={[
          { label: "Per answer", value: "thumbs · retry" },
          { label: "Per error", value: "Report button" },
          { label: "Full session", value: "/report" },
        ]}
      />

      <h2>Rate and retry</h2>
      <p>Each agent response has a small action row:</p>
      <ul>
        <li><strong>Thumbs up / down</strong> — mark a good or needs-work answer. Rating opens an inline form so you can add a note; feedback is logged locally.</li>
        <li><strong>Retry</strong> — re-run the same prompt to get a fresh attempt.</li>
        <li><strong>Undo</strong> — revert that message&rsquo;s file changes (see <Link href="/docs/checkpoints">Checkpoints &amp; Undo</Link>).</li>
      </ul>
      <p>Your feedback log is reachable via <strong>LakshX: Open Feedback Log</strong>.</p>

      <h2>Report a specific error</h2>
      <p>
        When something goes wrong mid-run, the error message that appears in the chat carries its own{" "}
        <strong>Report</strong> button. Click it and LakshX sends that error plus a full diagnostic report
        straight to the project — no copy-paste required.
      </p>
      <Callout variant="note" title="Only for the free hosted model, signed in">
        Sending a report needs you to be <Link href="/docs/sign-in">signed in</Link> and on the free{" "}
        <strong>LakshX</strong> model. If either isn&rsquo;t true, clicking Report tells you so instead of
        sending anything — a BYOK error is between you and your own provider, and a signed-out error has
        nowhere safe to go.
      </Callout>

      <h2>Diagnostic session report</h2>
      <p>
        Want to hand over a whole session, not just one error? Click the diagnostics icon in the chat topbar
        — &ldquo;Copy full diagnostic session report to clipboard&rdquo; — or run the slash command:
      </p>
      <CodeBlock lang="bash" title="composer">{`/report`}</CodeBlock>
      <p>
        LakshX assembles the whole session transcript and copies it to your clipboard, ready to paste into a
        bug report. It shows the character count on success so you know it worked. Unlike the Report button,
        this one works for anyone, on any model — it just leaves the sending to you.
      </p>

      <Callout variant="tip" title="Reporting a problem?">
        <code>/report</code>{" "}
        gives maintainers the full context of what happened in one paste — it&rsquo;s the fastest way to get a bug looked at.
      </Callout>
    </DocArticle>
  );
}
