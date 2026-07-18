import DocHeader from "../docs/_components/DocHeader";
import Callout from "../docs/_components/Callout";

export default function TermsPage() {
  return (
    <article className="docs-prose">
      <DocHeader eyebrow="Legal" title="Terms of Service">
        These terms govern your use of LakshX — the IDE application, the free hosted AI model, and any
        bring-your-own-key (BYOK) providers you connect. By downloading, installing, or using LakshX, you agree
        to these terms.
      </DocHeader>

      <Callout variant="note" title="Questions?">
        This is a plain-language draft covering the standard bases for a small, pre-revenue software product.
        It isn&rsquo;t a substitute for advice from a lawyer familiar with your specific situation. If anything
        here is unclear, or you need something not covered, reach us at{" "}
        <a href="mailto:contact@lakshx.in">contact@lakshx.in</a>.
      </Callout>

      <p className="text-sm text-white/50">
        <em>Last updated: July 19, 2026</em>
      </p>

      <h2>1. Acceptance of Terms</h2>
      <p>
        By accessing or using LakshX (&ldquo;the Service&rdquo;), you agree to be bound by these Terms of
        Service (&ldquo;Terms&rdquo;). If you do not agree to these Terms, do not download, install, or use the
        Service. We may update these Terms from time to time as described in{" "}
        <a href="#changes">Section 9</a>; continued use after an update constitutes acceptance of the revised
        Terms.
      </p>

      <h2>2. Description of Service</h2>
      <p>
        LakshX is a desktop code editor (a fork of Visual Studio Code) bundled with an agentic coding
        assistant. The Service includes:
      </p>
      <ul>
        <li>
          <strong>The IDE itself</strong> — the editor, extensions, and local tooling that run entirely on
          your machine.
        </li>
        <li>
          <strong>A free, hosted AI model</strong> (referred to in the app and this document as the
          &ldquo;LakshX model&rdquo;) that you may use after signing in. This tier is subsidized by us and is
          subject to a per-user budget cap and an overall budget ceiling shared across all users, both
          described in <a href="#acceptable-use">Section 4</a>. Because it&rsquo;s a shared, cost-capped
          resource, availability, response quality, and the specific underlying model may change without
          notice.
        </li>
        <li>
          <strong>Bring-your-own-key (BYOK) support</strong> for major third-party AI providers (for example
          Anthropic, OpenAI, OpenRouter, Google, DeepSeek, Groq, and xAI). When you use BYOK, you supply your
          own API key and contract directly with that provider under their own terms — LakshX simply routes
          your requests to the provider you configured.
        </li>
      </ul>

      <h2>3. Account Registration</h2>
      <p>
        Using the free hosted LakshX model requires signing in with a Google account (via Google OAuth). We
        receive basic profile information from Google — your email address, and, depending on your Google
        account settings, your name — to create and identify your account. You do not need an account to use
        the IDE with your own BYOK provider keys.
      </p>
      <p>
        You&rsquo;re responsible for maintaining the security of the Google account you sign in with, and for
        all activity that happens under your LakshX account. Let us know at{" "}
        <a href="mailto:contact@lakshx.in">contact@lakshx.in</a> if you suspect unauthorized use.
      </p>

      <h2 id="acceptable-use">4. Acceptable Use</h2>
      <p>You agree not to, and not to help or permit anyone else to:</p>
      <ul>
        <li>
          Attempt to circumvent, disable, or work around the free hosted model&rsquo;s per-user budget cap or
          the global budget ceiling (for example, by creating multiple accounts to obtain additional free
          usage, or by automating requests solely to exhaust shared capacity).
        </li>
        <li>
          Use the hosted model to generate content that is illegal, infringing, malicious (including malware
          or code intended to attack systems you don&rsquo;t own or have permission to test), or that violates
          the acceptable-use policies of our underlying model provider.
        </li>
        <li>
          Reverse-engineer, decompile, or attempt to extract the underlying model weights, prompts, or
          infrastructure behind the hosted LakshX model.
        </li>
        <li>
          Interfere with or disrupt the integrity or performance of the Service, or attempt to gain
          unauthorized access to it or its related systems or networks.
        </li>
        <li>
          Resell, sublicense, or otherwise provide the free hosted model&rsquo;s access to third parties as
          your own service.
        </li>
        <li>Use the Service in violation of any applicable law or regulation.</li>
      </ul>
      <p>
        We may suspend or terminate access to the hosted model (without affecting your ability to use the IDE
        with your own BYOK keys) for violations of this section.
      </p>

      <h2>5. Intellectual Property</h2>
      <p>
        <strong>Your code and content.</strong> You retain all rights, title, and interest in and to the code,
        prompts, and other content you create or process using LakshX. We claim no ownership over it. For
        BYOK usage, your code and prompts are sent directly from your machine to the provider you configured
        and are never routed through or stored on LakshX&rsquo;s own servers — see our{" "}
        <a href="/privacy">Privacy Policy</a> for the full data-handling breakdown.
      </p>
      <p>
        <strong>LakshX&rsquo;s software and branding.</strong> LakshX, the LakshX name, logo, and the
        LakshX-specific code, features, and branding layered on top of the underlying open-source editor are
        owned by us (or our licensors) and protected by applicable intellectual property laws. Except for the
        open-source components governed by their own licenses, these Terms don&rsquo;t grant you any right to
        use LakshX&rsquo;s trademarks, logos, or branding without our prior written permission.
      </p>

      <h2>6. Service Availability and Disclaimers</h2>
      <p>
        LakshX is currently a pre-revenue product operated by a small team. <strong>We do not guarantee any
        specific level of uptime, availability, or response time</strong> for the hosted model or any other
        server-side component of the Service, and we may modify, suspend, or discontinue any part of the
        Service (including the free hosted model) at any time, with or without notice.
      </p>
      <p>
        THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE,&rdquo; WITHOUT WARRANTIES OF ANY
        KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING WITHOUT LIMITATION WARRANTIES OF
        MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, OR THAT THE SERVICE WILL BE
        UNINTERRUPTED, ERROR-FREE, OR SECURE. AI-generated output (from the hosted model or any BYOK provider)
        may be inaccurate, incomplete, or unsuitable for your purposes — you&rsquo;re responsible for reviewing
        and testing any code or content before relying on it.
      </p>

      <h2>7. Limitation of Liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL LAKSHX, ITS OPERATORS, OR ITS
        LICENSORS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY
        LOSS OF PROFITS, REVENUE, DATA, OR GOODWILL, ARISING FROM OR RELATED TO YOUR USE OF THE SERVICE, EVEN
        IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. OUR TOTAL AGGREGATE LIABILITY FOR ANY CLAIM ARISING OUT
        OF OR RELATING TO THE SERVICE WILL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID US, IF ANY, IN THE
        TWELVE MONTHS PRECEDING THE CLAIM, OR (B) FIFTY U.S. DOLLARS ($50). Since the hosted model is currently
        offered free of charge, this generally caps our liability at a nominal amount for most users today —
        this will be revisited once a paid tier exists.
      </p>
      <p>Nothing in these Terms limits liability that cannot be limited under applicable law.</p>

      <h2>8. Termination</h2>
      <p>
        <strong>By you.</strong> You may stop using the Service at any time, and may request deletion of your
        account and associated data by emailing <a href="mailto:contact@lakshx.in">contact@lakshx.in</a> (see
        our <a href="/privacy">Privacy Policy</a> for details).
      </p>
      <p>
        <strong>By us.</strong> We may suspend or terminate your access to the hosted model or your account —
        for breach of these Terms, for suspected abuse of the free tier, to protect the Service or other
        users, or because we&rsquo;re discontinuing the Service or a feature of it — with notice where
        reasonably practicable. Termination of your hosted-model account does not affect your ability to keep
        using the LakshX IDE with your own BYOK provider keys.
      </p>

      <h2>9. Changes to These Terms</h2>
      <p id="changes">
        We may revise these Terms from time to time, for example as we introduce paid plans or new features.
        We&rsquo;ll update the &ldquo;Last updated&rdquo; date above when we do, and for material changes
        we&rsquo;ll make reasonable efforts to give notice (such as an in-app or email notice). Continuing to
        use the Service after a change takes effect means you accept the revised Terms.
      </p>

      <h2>10. Governing Law</h2>
      <p>
        These Terms are governed by the laws of India, without regard to its conflict-of-laws principles, and
        any disputes will be subject to the exclusive jurisdiction of the courts located in India.
      </p>
      {/*
        FOUNDER TODO: "India" is a placeholder, not a confirmed fact. We don't
        know the actual jurisdiction of incorporation / registered business
        address for LakshX yet. Governing-law and venue clauses should name
        the country (and ideally state/city) where the operating entity is
        actually registered, once that's decided — swap this section (and
        the venue reference above) for the correct jurisdiction before
        treating this page as final. Flagged again in the task report.
      */}

      <h2>11. Contact</h2>
      <p>
        Questions about these Terms? Reach us at{" "}
        <a href="mailto:contact@lakshx.in">contact@lakshx.in</a>.
      </p>
    </article>
  );
}
