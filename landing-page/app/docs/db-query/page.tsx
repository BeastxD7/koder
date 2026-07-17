import type { Metadata } from "next";
import Link from "next/link";
import DocArticle from "../_components/DocArticle";
import DocHeader, { AccessRow } from "../_components/DocHeader";
import Callout from "../_components/Callout";
import CodeBlock from "../_components/CodeBlock";

export const metadata: Metadata = {
  title: "db_query & Data Browse",
  description: "Let the LakshX agent read real database rows — read-only, opt-in per connection.",
};

export default function DbQueryPage() {
  return (
    <DocArticle>
      <DocHeader eyebrow="Databases" title="db_query & Data Browse">
        Sometimes the agent needs to see real data to help — the actual shape of a row, a sample record, a
        count. The <code>db_query</code> tool lets it run read-only queries against a database you connected,
        but only if you explicitly turn it on for that connection.
      </DocHeader>

      <AccessRow
        items={[
          { label: "Toggle", value: "Allow AI queries" },
          { label: "Default", value: "OFF" },
          { label: "Engines", value: "Postgres · MySQL · SQLite · MongoDB" },
        ]}
      />

      <h2>Turning it on</h2>
      <p>
        In the <Link href="/docs/databases">Database panel</Link>, each connection has an{" "}
        <strong>Allow AI queries</strong>{" "}
        toggle — &ldquo;Let the AI assistant run read-only queries against
        this connection.&rdquo; It is <strong>off by default</strong>. Flip it on per connection when you
        want the agent to read from that database.
      </p>

      <Callout variant="warning" title="Real rows go to your model provider">
        The whole point of this feature is sending actual rows to the LLM. Read-only protects the database,
        not against what&rsquo;s read leaving your machine. Prefer a non-production connection, and only
        enable it on data you&rsquo;re comfortable sharing with your model provider.
      </Callout>

      <h2>How the agent uses it</h2>
      <p>
        Once enabled, you just ask — for example &ldquo;show me a few rows from the orders table so we get
        the column names right.&rdquo; The agent issues a <code>db_query</code> and the result renders in a
        read tool-card, marked as a read-only, rolled-back transaction:
      </p>
      <CodeBlock lang="text" title="db_query result">{`postgres · shop_dev  (read-only transaction, rolled back)
columns: id, email, status, created_at
rows (showing 3 of 4123)
  1  ada@example.com   active   2026-05-01
  2  grace@example.com paused   2026-05-02
  3  linus@example.com active   2026-05-03`}</CodeBlock>

      <h2>What keeps it safe</h2>
      <ul>
        <li><strong>Connection-level read-only</strong> — queries run inside a read-only transaction that is always rolled back. This is the primary control, not just a keyword filter.</li>
        <li><strong>Statement allowlist</strong> — only <code>SELECT</code>, <code>WITH…SELECT</code>, <code>SHOW</code>, and <code>EXPLAIN</code> are accepted; writes and DDL are rejected up front.</li>
        <li><strong>Row cap</strong> — results are capped (default 50, hard max 1000), with a truncation marker and the true count.</li>
        <li><strong>Per-query timeout</strong> and result-size clipping.</li>
        <li><strong>No credentials to the agent</strong> — the tool references a connection by engine id and relays through the DB extension; it never sees your connection secrets.</li>
      </ul>

      <Callout variant="royal" title="Royal mode can't bypass the opt-in">
        The consent check lives inside the database extension that owns the credentials, reached only across
        an extension boundary. The agent&rsquo;s mode is invisible there — so even{" "}
        <Link href="/docs/royal-mode">Royal mode</Link> cannot auto-enable AI queries. If the toggle is off,
        the query is refused.
      </Callout>

      <h2>Engine support</h2>
      <p>
        <code>db_query</code> works against all four engines — <strong>PostgreSQL, MySQL, SQLite, and
        MongoDB</strong>. The SQL engines take a query written as SQL text; MongoDB instead takes a
        JSON-stringified query spec (<code>{`{"collection":"users","filter":{"active":true},"limit":20}`}</code>).
        MongoDB has no engine-level read-only transaction to roll back, so its read-only guarantee is
        structural instead: only <code>find</code> runs — no <code>$out</code>/<code>$merge</code>/aggregation
        side effects, and no update operators (<code>$set</code>, <code>$inc</code>, …) are accepted anywhere
        in the filter, including nested inside <code>$and</code>/<code>$or</code>.
      </p>
    </DocArticle>
  );
}
