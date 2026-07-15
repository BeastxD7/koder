# Research: De-VSCode-ification + Custom Agent Panel (July 2026)

Gold standard: VSCodium's build system — product.json rewrite + ordered patches/ dir + icon regeneration. Their patch set is the authoritative map of "everything product.json can't fix."

## Tier A — product.json alone (✅ mostly done in product.overrides.json)
name/applicationName/dataFolder/urlProtocol/bundle ids/win32 ids; licenseUrl/reportIssueUrl/docs/twitter/tips URLs (removed); updateUrl/downloadUrl; extensionsGallery→Open VSX; telemetry keys off.
**Chat/AI keys**: defaultChatAgent (NOTE: cannot be deleted — `onboardingVariationA.ts` asserts it exists and `defaultAccount.ts` reads `.provider.default.id` etc. → stub with inert LakshX values, which we do), chatParticipantRegistry, chatSessionRecommendations, agentSdks, aiGeneratedWorkspaceTrust (deleted ✅).

## Tier B — needs source patches (Phase 2 backlog, copy VSCodium's)
- `brand-remove-branding.patch`: 100+ hardcoded "VS Code"/"Visual Studio Code" strings — grep targets: "VS Code", "Visual Studio Code", "Code - OSS", vscode.dev, aka.ms. Touches workbench contribs, extension nls files, settings descriptions ("Copilot"/"GitHub" leak in Settings editor).
- Welcome/Getting Started walkthroughs (VS Code-branded videos + Copilot upsells) — replace with LakshX walkthrough.
- Issue reporter hardwired to microsoft/vscode.
- Settings Sync/cloud removal; update-system patches; telemetry hard-off.
- **Copilot removal at build level** (dev-mode rm is enough for now ✅): VSCodium `52-ext-copilot-remove-it.json` removes extensions/copilot + most of src/vs/platform/agentHost/ (~70 paths); `53-*.patch` removes compileCopilotExtensionBuildTask from gulpfiles, extensions/copilot from build/npm/dirs.ts, @anthropic-ai/sdk + @github/copilot-sdk from package.json + postinstall symlinks.
- Packaging metadata (deb/rpm/snap templates), letterpress SVGs in src/vs/workbench/browser/parts/editor/media/.
- build/lib/electron.ts: companyName "Microsoft Corporation", copyright, darwinHelpBookName — patch.

## Built-in chat UI: the sanctioned switches (✅ applied via koder-ui configurationDefaults)
- `chat.disableAIFeatures: true` — global kill switch (hides Chat views + inline chat, disables Copilot extensions)
- `chat.commandCenter.enabled: false` — title-bar chat button
- Residual benign log line: "CodeExpectedError: No default agent contributed".
- Alternative strategy (worth considering Phase 2): REPURPOSE core contrib/chat (streamed markdown renderer, tool-call UI are genuinely good) driven by LakshX's runtime via chat participant API, de-branded via patch. Void amputated + rebuilt native; Cursor built proprietary native UI; PearAI bundled a Continue fork.

## Custom agent panel architecture patterns
- **Void** (best open fork reference): native ViewPane in auxiliary bar from src/vs/workbench/contrib/void/browser/, React pre-compiled + mounted into ViewPane DOM; LLM work in electron-main services over IPC with @IService DI.
- **Cline**: sidebar WebviewView, React+Vite, protobuf over postMessage.
- **Continue/PearAI**: core↔extension↔gui three-layer message passing.
- webview-ui-toolkit is DEPRECATED (archived Jan 2025).
- Webview pitfalls: markdown re-render thrash while streaming (memoize + debounce ✅ we debounce 60ms), postMessage overhead per token, cold-start, no workbench theming except CSS vars.
- LakshX v1 = webview extension (shipped ✅); Phase 2 option = native ViewPane à la Void for zero-webview cost.

## Icons
- **Product icons (codicons)**: `contributes.productIconThemes` (font glyphs, single color; unthemed IDs fall back to codicons). Candidates: Fluent Icons (MIT, unmaintained since Oct 2024), Carbon (antfu, MIT/Apache), Material Product Icons (MIT). Custom theme is LOW effort: microsoft/vscode-extension-samples product-icon-theme-sample + fantasticon SVG→WOFF pipeline. Fork-level alternative: replace codicon.ttf itself (icons CC-BY-4.0, attribution required).
- **File icons**: replace Seti with **Symbols** (miguelsolorio, MIT) — recommended; or Material Icon Theme / Catppuccin (both MIT). Bundle as builtin, set workbench.iconTheme default.
- **App icon** (✅ done): build/lib/electron.ts uses resources/darwin/code.icns (darwinIcon), resources/win32/code.ico, resources/linux/code.png; VSCodium icons/build_icons.sh is the copyable CI pipeline (rsvg-convert + png2icns + ImageMagick). Our scripts/make-icon.sh does qlmanage+sips+iconutil for macOS.

## Legal
VS Code name/icon/marketplace are Microsoft trademarks/ToS-restricted — full replacement required (code.visualstudio.com/brand). Cursor/Windsurf did full renames the same way; VSCodium is the only complete public reference.

Sources: github.com/VSCodium/vscodium (patches/, icons/build_icons.sh) · deepwiki.com/VSCodium · github.com/microsoft/vscode extensions/copilot · code.visualstudio.com/docs/agents/reference/ai-settings · code.visualstudio.com/api/extension-guides/product-icon-theme · github.com/voideditor/void · deepwiki.com/cline · github.com/trypear/pearai-app · github.com/microsoft/vscode-gulp-electron
