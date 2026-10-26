<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->
- Server function files (*.functions.ts) live in src/lib, never src/server — src/server is blocked from the browser bundle.
- Structured style profiles (v2) live in src/lib/style-profile.ts and are stored inside the existing style_profiles.profile JSON under `structured`, keeping legacy fields; always read via readStyleProfile — avoids destructive migrations.
- Renderer style (agent/style_apply.py) resolves params with precedence: cost/safety lock > explicit user (edited scenes, sfx off, manual caption, settings.user_overrides) > v2 profile traits (measured high/medium; inferred only medium+, flagged) > legacy DNA > defaults; without a v2 profile the legacy path runs unchanged — keeps old productions working.
- Production→style linking goes through src/lib/style-link.ts resolveStyleLink: only same user + same reference (via analyses) + v2 present, exactly one candidate, else no link; the agent bundle persists style_id only for never-rendered productions — prevents cross-user/cross-reference leaks and leaves old productions untouched.
- Every agent file imported at runtime must also be in public/downloads/agente-estudio-windows.zip (root entries) — the Windows agent runs from that zip.
