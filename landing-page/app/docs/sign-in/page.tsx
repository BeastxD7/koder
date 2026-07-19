import type { Metadata } from "next";
import Link from "next/link";
import DocArticle from "../_components/DocArticle";
import DocHeader, { AccessRow } from "../_components/DocHeader";
import Callout from "../_components/Callout";
import CodeBlock from "../_components/CodeBlock";

export const metadata: Metadata = {
  title: "Sign In & Models",
  description: "The free hosted LakshX model, or bring your own Anthropic/OpenAI/Gemini/etc. key.",
};

export default function SignInPage() {
  return (
    <DocArticle>
      <DocHeader eyebrow="Getting Started" title="Sign In & Models">
        LakshX needs a model to talk to. Sign in with Google for the free hosted model — no API key, no
        setup — or bring your own key from any supported provider. Both live in the same settings panel and
        you can use either, or both, at once.
      </DocHeader>

      <AccessRow
        items={[
          { label: "Open", value: "AI Providers panel" },
          { label: "Sign in", value: "Sign In button (LakshX provider)" },
          { label: "BYOK", value: "LakshX: Configure AI Providers (BYOK)" },
        ]}
      />

      <h2>The free hosted model</h2>
      <p>
        Open the AI Providers panel, select <strong>LakshX (free, no key needed)</strong> as the provider,
        and click <strong>Sign In</strong>. It opens <code>lakshx.in/login</code> in your browser for a
        normal Google sign-in, then redirects back into the IDE and you&rsquo;re done — no key to copy, no
        account form.
      </p>
      <p>
        Once you&rsquo;re signed in, <strong>LakshX</strong> shows up as a provider you can select and set as
        default, same as any other. It&rsquo;s a hosted model the project runs and pays for, so it comes with
        a fair-use budget:
      </p>
      <ul>
        <li>Each signed-in user gets a <strong>$5</strong> usage allowance.</li>
        <li>
          There&rsquo;s also a shared, project-wide ceiling across every user — how the free tier stays
          free for everyone rather than one heavy user exhausting it for the rest.
        </li>
        <li>
          The settings panel shows your own spend against your allowance once you&rsquo;re signed in. If a
          request is refused for being over budget, that&rsquo;s what happened — switch to a BYOK
          provider to keep going.
        </li>
      </ul>

      <Callout variant="tip" title="You can watch it think">
        The hosted model streams its reasoning as it works, not just the final answer — the same
        &ldquo;thinking&rdquo; stream you&rsquo;d get from a reasoning-capable BYOK model, live in the
        transcript.
      </Callout>

      <h2>Bring your own key (BYOK)</h2>
      <p>
        Prefer your own provider, or need a specific model the hosted option doesn&rsquo;t offer? Run{" "}
        <strong>LakshX: Configure AI Providers (BYOK)</strong> from the command palette, pick a provider, and
        paste in an API key:
      </p>
      <ul>
        <li><strong>Anthropic</strong>, <strong>OpenAI</strong>, <strong>Google Gemini</strong>, <strong>DeepSeek</strong>, <strong>Groq</strong>, and <strong>xAI (Grok)</strong> — each with a short list of current model suggestions.</li>
        <li><strong>OpenRouter</strong> — routes to hundreds of models across every provider, so there&rsquo;s no fixed list at all.</li>
      </ul>
      <p>
        The model field itself is a free-text box with autocomplete suggestions, not a locked dropdown — type
        any model id the provider supports, even one that isn&rsquo;t in the suggestion list yet.
      </p>
      <CodeBlock lang="text" title="AI Providers panel">{`AI Provider:  Anthropic (Claude)
Model:        claude-sonnet-5        <- type-to-search, not a fixed list
[x] Use as default model`}</CodeBlock>

      <Callout variant="note" title="Keys are stored locally, in plain text">
        BYOK keys are saved to <code>~/.lakshx/providers.json</code> on your machine — never uploaded
        anywhere. It&rsquo;s a plain JSON file rather than an OS credential vault, so treat it like any other
        local secret (don&rsquo;t commit it, don&rsquo;t sync it to somewhere public).
      </Callout>

      <h2>Switching the active model</h2>
      <p>
        Pick a model from the dropdown in the composer toolbar, or switch mid-chat with the slash command
        (see <Link href="/docs/slash-commands">Slash Commands</Link>):
      </p>
      <CodeBlock lang="bash" title="composer">{`/model claude-sonnet-5   # switch to a specific model
/model                   # bare — focuses the model picker`}</CodeBlock>
      <p>
        Checking &ldquo;Use as default model&rdquo; in the AI Providers panel makes that choice persist
        across new chats, not just the current one.
      </p>

      <h2>Signing out</h2>
      <p>
        Click <strong>Sign Out</strong> next to the LakshX provider in the AI Providers panel. This only
        clears your hosted-model session — any BYOK keys you&rsquo;ve configured keep working.
      </p>
    </DocArticle>
  );
}
