import DocHeader from "../docs/_components/DocHeader";
import Callout from "../docs/_components/Callout";

export default function PrivacyPage() {
  return (
    <article className="docs-prose">
      <DocHeader eyebrow="Legal" title="Privacy Policy">
        This page describes, as specifically as we can, what LakshX actually collects, what it deliberately
        does <em>not</em> collect, and where your data goes. The short version: if you bring your own API key
        (BYOK), your code and prompts never touch our servers. If you use the free hosted model, we collect a
        limited, specific set of data described below — not a full transcript of everything you do.
      </DocHeader>

      <Callout variant="note" title="Questions?">
        This is a plain-language draft, written against the product&rsquo;s actual code rather than generic
        boilerplate, but it isn&rsquo;t a substitute for advice from a lawyer or privacy professional. If
        something here doesn&rsquo;t match what you&rsquo;d expect, or you want more detail, email{" "}
        <a href="mailto:contact@lakshx.in">contact@lakshx.in</a>.
      </Callout>

      <p className="text-sm text-white/50">
        <em>Last updated: July 19, 2026</em>
      </p>

      <h2>The local-vs-cloud boundary, honestly stated</h2>
      <p>
        LakshX can run entirely locally. If you configure your own API key for a provider (Anthropic, OpenAI,
        OpenRouter, Google, DeepSeek, Groq, xAI, etc. — &ldquo;BYOK&rdquo;), your prompts, your code, and the
        agent&rsquo;s responses go directly from your machine to that provider using your key. They are never
        routed through, logged by, or stored on LakshX&rsquo;s own servers — being signed in to a LakshX
        account for other reasons (like tracking free-tier usage) does not change this. Your local activity log
        (feedback you give the agent, stored at <code>~/.lakshx/feedback/</code> on your own disk) also stays
        on your machine by default.
      </p>
      <p>
        The data described in the rest of this policy applies specifically to the parts of LakshX that talk to
        our servers: signing in, and using the free hosted &ldquo;LakshX model.&rdquo;
      </p>

      <h2>Information We Collect</h2>

      <h3>Account information</h3>
      <p>
        When you sign in to use the free hosted model, we use Google OAuth to authenticate you. We receive
        your email address (and, depending on your Google account, your name) from Google to create and
        identify your LakshX account. We don&rsquo;t receive your Google password.
      </p>

      <h3>Usage and budget data</h3>
      <p>
        The free hosted model is subsidized and budget-capped, so we track, per signed-in user: token counts
        (input/output) and the computed cost of each request, plus your running total spend against your
        per-user credit limit. We also track an overall running total against a shared global budget ceiling
        across all users, so the free tier stays within what we can actually afford to subsidize. This is
        purely numeric usage/cost data — it is not a transcript of what you asked or what the model said.
      </p>

      <h3>Feedback you submit</h3>
      <p>
        The chat panel lets you rate a hosted-model response (thumbs up, thumbs down, or retry) and optionally
        leave a comment or describe what went wrong. If you do this <strong>while using the free hosted
        model</strong>, that rating, your optional comment, and an excerpt of the relevant prompt and response
        (truncated at 2,000 characters) are sent to our servers so we can improve the hosted model&rsquo;s
        quality. This never happens for BYOK usage — feedback you give on a BYOK conversation is written only
        to your local feedback log.
      </p>

      <h3>Error reports (only when you click &ldquo;Report&rdquo;)</h3>
      <p>
        If an error occurs while you&rsquo;re signed in and using the free hosted model, the chat panel shows a
        short, sanitized error message with an optional <strong>&ldquo;Report&rdquo;</strong> button. We only
        receive the fuller diagnostic detail (a longer session dump — things like the recent conversation,
        workspace name, chat title, session id, and which model/mode you were using) if you explicitly click
        that button. We never collect this automatically, and it&rsquo;s never collected at all for BYOK usage.
      </p>

      <h3>Agent runtime metadata</h3>
      <p>Two more limited, metadata-only signals are sent to our servers, each gated differently:</p>
      <ul>
        <li>
          <strong>Tool-call audit metadata</strong> — while actively using the free hosted model, we record
          which tool the agent called (e.g. &ldquo;read file&rdquo;), whether it was allowed or blocked, whether
          it errored, and how long it took. We explicitly do <strong>not</strong> collect the tool&rsquo;s actual
          input or output — no file contents, no command text, no arguments. The full detail of what a tool
          actually did stays in a local-only audit log on your machine; our servers only ever see the coarse
          shape of it. Like feedback and error reports, this is scoped to hosted-model usage — it&rsquo;s not
          collected while you&rsquo;re on a BYOK provider.
        </li>
        <li>
          <strong>Agent incident reports</strong> — if the local agent process crashes, fails to start, or a
          request times out, we log a short, fixed-vocabulary reason (e.g. &ldquo;agent exited (code 1)&rdquo;
          or &ldquo;request timed out after…&rdquo;), capped at 500 characters — never a full log dump. This one
          is about the health of the local agent process itself, not which model you were talking to, so it
          applies whenever you&rsquo;re signed in — including while using a BYOK provider — rather than being
          limited to hosted-model usage.
        </li>
      </ul>

      <h3>Sign-in activity</h3>
      <p>
        We log whether a sign-in attempt succeeded or failed (with a timestamp), to help us monitor and debug
        the authentication flow.
      </p>

      <h2>What We Do NOT Collect</h2>
      <ul>
        <li>Your BYOK prompts, code, or responses — these never reach our servers at all (see above).</li>
        <li>
          Raw tool inputs or commands run by the agent (file contents, shell commands, arguments) — even for
          hosted-model usage, we only ever receive the coarse metadata described above, never the content.
        </li>
        <li>
          Full conversation transcripts, by default — only the specific, limited slices described above
          (excerpts on explicit feedback, or a full dump only if you click &ldquo;Report&rdquo;).
        </li>
        <li>Your Google account password, or any other credentials for third-party services you connect via BYOK.</li>
      </ul>

      <h2>Third Parties We Work With</h2>
      <ul>
        <li>
          <strong>Supabase</strong> — provides authentication and the database that stores the account and
          usage data described above.
        </li>
        <li>
          <strong>Microsoft Azure OpenAI</strong> — processes the actual inference requests for the free
          hosted model. Your prompt and the model&rsquo;s response pass through Azure to generate the reply,
          the same as any AI product built on a model API.
        </li>
        <li>
          <strong>Google</strong> — provides the OAuth sign-in flow used to authenticate your account.
        </li>
        <li>
          Any <strong>BYOK provider</strong> you configure yourself (Anthropic, OpenAI, OpenRouter, Google,
          DeepSeek, Groq, xAI, etc.) — you contract with them directly under their own terms; we&rsquo;re not a
          party to that relationship and never see that traffic.
        </li>
      </ul>

      <h2>Cookies and Analytics</h2>
      <p>
        The lakshx.in website uses a functional cookie set by Supabase to keep you signed in (and, briefly
        during sign-in, to complete the OAuth handshake). We do not currently run any third-party analytics,
        advertising, or tracking scripts on this site.
      </p>

      <h2>Data Retention</h2>
      <p>
        We retain account, usage, and the other data described above for as long as your account is active,
        or as needed to provide the Service (for example, to enforce the per-user budget cap, which requires
        knowing your running total spend). You can request deletion at any time — see{" "}
        <a href="#your-rights">Your Rights</a> below.
      </p>

      <h2 id="your-rights">Your Rights</h2>
      <p>
        You can request access to, or deletion of, your account and associated data by emailing{" "}
        <a href="mailto:contact@lakshx.in">contact@lakshx.in</a>. We&rsquo;ll respond and act on verifiable
        requests within a reasonable time. Deleting your account does not affect any BYOK usage, since we
        never held that data to begin with.
      </p>

      <h2>Children&rsquo;s Privacy</h2>
      <p>
        LakshX is not directed at children, and we do not knowingly collect personal information from anyone
        under the age of 13 (or the relevant minimum age in your jurisdiction). If you believe a child has
        provided us with personal information, contact us at{" "}
        <a href="mailto:contact@lakshx.in">contact@lakshx.in</a> and we&rsquo;ll delete it.
      </p>

      <h2>International Users</h2>
      <p>
        LakshX is used globally, and the third-party services listed above may process and store data in
        countries other than your own. By using the Service, you understand that your information may be
        transferred to, and processed in, jurisdictions with different data-protection laws than where you
        live.
      </p>

      <h2>Changes to This Policy</h2>
      <p>
        We may update this Privacy Policy as the product changes — for example, if we introduce paid plans or
        new features that collect additional data. We&rsquo;ll update the &ldquo;Last updated&rdquo; date above
        when we do, and for material changes we&rsquo;ll make reasonable efforts to give notice.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this Privacy Policy, or a request to access or delete your data? Email{" "}
        <a href="mailto:contact@lakshx.in">contact@lakshx.in</a>.
      </p>
    </article>
  );
}
