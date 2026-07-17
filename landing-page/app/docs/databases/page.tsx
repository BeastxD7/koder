import type { Metadata } from "next";
import Link from "next/link";
import DocArticle from "../_components/DocArticle";
import DocHeader, { AccessRow } from "../_components/DocHeader";
import Callout from "../_components/Callout";

export const metadata: Metadata = {
  title: "Database Visualization",
  description: "ER diagrams for MongoDB, PostgreSQL, MySQL, and SQLite in the LakshX DB panel.",
};

export default function DatabasesPage() {
  return (
    <DocArticle>
      <DocHeader eyebrow="Databases" title="Database Visualization">
        Connect a database and LakshX draws it — tables, collections, and the relationships between them —
        as an ER diagram, right inside the IDE. It works across four engines.
      </DocHeader>

      <AccessRow
        items={[
          { label: "Status bar", value: "$(database) DB" },
          { label: "Command", value: "LakshX: Show Database Panel" },
        ]}
      />

      <h2>Supported engines</h2>
      <ul>
        <li><strong>PostgreSQL</strong>, <strong>MySQL</strong>, <strong>SQLite</strong> — relational schemas with real foreign keys, drawn as solid relationship edges.</li>
        <li><strong>MongoDB</strong> — collections with relationships inferred from your documents.</li>
      </ul>

      <h2>Opening the panel</h2>
      <p>Two ways in:</p>
      <ul>
        <li>Click <strong>DB</strong> in the status bar (the database icon).</li>
        <li>Run <strong>LakshX: Show Database Panel</strong> from the command palette.</li>
      </ul>

      <h2>Connecting</h2>
      <ul>
        <li><strong>SQLite</strong> — pick the database file with an open dialog; it opens read-only.</li>
        <li><strong>PostgreSQL / MySQL / MongoDB</strong> — paste a connection string into a masked input, validated against the engine&rsquo;s scheme.</li>
      </ul>
      <p>
        Credentials are stored in the IDE&rsquo;s per-extension secret storage — never in a file in your
        repo. To switch databases, use <strong>Change Connection…</strong> in the panel, or run{" "}
        <strong>LakshX: Forget Database Credentials</strong> to clear them.
      </p>

      <h2>Reading the diagram</h2>
      <p>
        The panel&rsquo;s <strong>Schema</strong> tab renders your database as an entity-relationship
        diagram, so you can see structure and joins at a glance instead of piecing them together from
        migration files.
      </p>

      <h2>Browsing real rows — the Data tab</h2>
      <p>
        Switch to the <strong>Data</strong> tab to browse actual rows yourself: pick a table/collection from
        the dropdown and page through its contents directly, with client-side column sorting. This is
        <strong> you</strong> looking at your own data — it works whether or not <strong>Allow AI
        queries</strong> is on, and it&rsquo;s unrelated to the agent.
      </p>

      <Callout variant="tip" title="Data tab vs. Allow AI queries — two different things">
        The <strong>Data</strong> tab has no query box — there&rsquo;s nowhere to type a question here.
        &ldquo;Allow AI queries&rdquo; is a separate opt-in that lets the <em>coding agent</em> (in the chat
        panel) read rows while it works, in response to something you ask it in plain language — see{" "}
        <Link href="/docs/db-query">db_query</Link>. Turning that toggle on doesn&rsquo;t add anything to
        this panel; it changes what the agent is allowed to do elsewhere.
      </Callout>
    </DocArticle>
  );
}
