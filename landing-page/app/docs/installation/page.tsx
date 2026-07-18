import type { Metadata } from "next";
import Link from "next/link";
import DocArticle from "../_components/DocArticle";
import DocHeader from "../_components/DocHeader";
import Callout from "../_components/Callout";
import CodeBlock from "../_components/CodeBlock";

export const metadata: Metadata = {
  title: "Installation",
  description: "Download and run LakshX on macOS, Windows, or Linux.",
};

export default function InstallationPage() {
  return (
    <DocArticle>
      <DocHeader eyebrow="Getting Started" title="Installation">
        LakshX ships as a native app for macOS, Windows, and Linux. Grab the installer for your platform
        from the download button and follow the first-launch note below.
      </DocHeader>

      <h2>Download</h2>
      <p>
        Head to the <Link href="/#download">download section</Link> on the home page. LakshX detects your
        operating system and offers the right build:
      </p>
      <ul>
        <li><strong>macOS (Apple Silicon)</strong> — a <code>.dmg</code> installer. Open it and drag LakshX into Applications.</li>
        <li><strong>Windows</strong> — a <code>Setup.exe</code> installer.</li>
        <li><strong>Linux</strong> — a <code>.tar.gz</code> archive (a <code>.deb</code> is produced by the release build).</li>
      </ul>

      <Callout variant="note" title="macOS Intel">
        LakshX currently ships an Apple Silicon build. Intel (x64) is not in the release matrix yet, so the
        Intel option shows as &ldquo;coming soon&rdquo; rather than a broken link.
      </Callout>

      <h2>First launch on macOS</h2>
      <p>
        LakshX isn&rsquo;t Apple-notarized yet, so macOS may say the app{" "}
        <strong>&ldquo;is damaged and can&rsquo;t be opened.&rdquo;</strong> This is a false alarm, not a
        broken download. Clear the quarantine flag once:
      </p>
      <CodeBlock lang="bash">{`xattr -cr /Applications/LakshX.app`}</CodeBlock>
      <p>
        Or right-click LakshX in Applications and choose <strong>Open</strong> instead of double-clicking.
      </p>

      <h2>First launch on Windows</h2>
      <p>
        LakshX isn&rsquo;t a Microsoft-verified publisher yet, so Windows SmartScreen may show{" "}
        <strong>&ldquo;Windows protected your PC.&rdquo;</strong> Click <strong>More info</strong>, then{" "}
        <strong>Run anyway</strong>.
      </p>

      <Callout variant="tip" title="Prefer to build it yourself?">
        You can produce a signed-to-yourself native installer from source with a single command. See{" "}
        <Link href="/docs/building">Building from Source</Link>.
      </Callout>

      <h2>Next steps</h2>
      <ul>
        <li><Link href="/docs/sign-in">Sign in for the free model</Link>, or add your own provider key.</li>
        <li>Open the <Link href="/docs/chat">chat panel</Link> and describe what you want.</li>
        <li>Learn the <Link href="/docs/modes">safety modes</Link> before granting autonomy.</li>
        <li>Try <Link href="/docs/slash-commands">slash commands</Link> to steer the agent quickly.</li>
      </ul>
    </DocArticle>
  );
}
