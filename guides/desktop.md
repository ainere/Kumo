# Desktop App

How the desktop app is put together, and how to run your own background scenes. Back to the [README](../README.md).

## What's in it

`apps/desktop` is an Electron app on the same engine as the CLI, Windows first. The shell, the chat, the Settings page, first-run onboarding, and the tabbed Workbench (Workers, Files, Diff, Terminal, Browser, Plan, Command Palette, Quick Open, and `@`-mentions) are built in.

- **Studio layout:** a glass title bar with the window buttons inside it, a sidebar with projects, chats and usage, the conversation, a glass composer, and a Workbench dock (`right`, `bottom`, `floating` or `hidden`) that resizes from its edge, splits into two side-by-side/stacked panes, or pops any tab out into its own window. A new chat opens on the "what should we build?" screen.
- **Usage:** one bar per subscription (Claude, Codex, and each Antigravity pool: Gemini, Gemini 4 Argon, Claude/GPT). The light fill is what's left of the 5-hour window, the darker fill is the weekly window, and the shorter of the two is drawn on top so both stay visible. The reset times are under the bar, and the full detail is in its tooltip. Both colors are mixed from the accent (`--meter-5h` and `--meter-week` in `tokens.css`). The bars refresh every 10 seconds; `kumo config set quotaPollMs 30000` polls less often. The sidebar shows the subscriptions the crew draws on; Settings › Accounts shows every signed-in one, whether a role uses it or not.
- **Workbench:**
  - **Workers:** an "All" tab, then one tab per role that ran in this chat, then "Other" for worker calls with no role. A role with a worker still running shows a timer and three waving dots (still dots under reduced motion). Each run is a card that opens to its task and live output.
  - **Files:** the project's tree (in a git repository, what git tracks plus new files that aren't ignored) with a filter, and a read-only CodeMirror viewer with `@ Mention` and copy. Refreshes when a worker finishes and when you come back to the window.
  - **Diff:** uncommitted changes against `HEAD`, new files included, for the open folder only. Approvals are answered here; the chat shows a one-line notice with a **Review** button. Click a line to leave a review comment, then send them to the lead together. Opening a project runs nothing from its own `.git/config`: hooks, text conversions and filters defined inside it stay off, so a file a repository-only filter handles (git-crypt, say) can show as changed here. Filters in your global git config, like Git LFS, still apply.
  - **Terminal:** a real shell in a pty (xterm.js and node-pty; PowerShell 7 if installed, else Windows PowerShell, or `$SHELL`). It belongs to the project, not the tab, so a dev server keeps running while you look elsewhere and its recent output comes back with you. Ctrl+C interrupts, Ctrl+Shift+C copies, Ctrl+V pastes.
  - **Browser:** a native `WebContentsView` in its own `persist:kumo-browser` partition. Dev servers show up as pills, whether they're on a usual port or one the terminal mentioned. Native views draw above the window, so the page steps aside while the palette, Settings or a dialog is open.
  - **Plan:** the chat's tasks, from the lead's markdown checklists (`- [ ]` / `- [x]`), or `PLAN.md` / `TODO.md` when the chat has none, plus your own. A task you remove stays removed, and **Run next task** sends the first open one to the lead.
  - **Pop-outs** show the main window's session: no second lead, and a theme or layout change reaches every window. `@ Mention` and **Open file** in a pop-out act in the main window.
- **Command Palette (`Ctrl+K`), Quick Open (`Ctrl+P`), and `@` Mentions:** `Ctrl+K` searches panel, dock, chat, theme and settings commands; `Ctrl+P` finds files by name, or by letters in order (`Alt+Enter` mentions the file instead of opening it); typing `@` in the composer does the same inline. `Ctrl+B` shows or hides the Workbench.
- **Glass over a live scene:** panels, messages and the composer are translucent and blurred over a background scene. The built-in scenes are **Clouds**, **Night sky** and **None** (grid only). They drift on their own, gather toward the Workers panel while workers run, and ripple when one finishes.
- **Light and dark** follow the system unless you pick one. The accent, scene, frame rate, grid, Workbench dock, blur and glass opacity are in Settings › Appearance (the gear, or Ctrl+,) and saved to `~/.kumo/desktop.json`. The OS "reduce transparency" and "reduce motion" settings are honored.
- **Window buttons** are round, in the title bar, and colored by the theme: `--win-close`, `--win-min` and `--win-max` in [`tokens.css`](../apps/desktop/src/renderer/src/styles/tokens.css), with their own values for light and dark. On macOS the native traffic lights move into the same spot.
- **Chat:** answers stream as Markdown, with each worker call shown where it happened, as a card with its model and time. Its live output streams into the Workers panel. Approvals appear as cards with a fixed amber strip that themes can't restyle. Chats resume with their provider conversation.

Run it from the repository (the root `npm install` installs the app through npm workspaces):

```powershell
npm run dev -w @kumo/desktop        # development, with hot reload
npm run build -w @kumo/desktop      # build to apps/desktop/out
npm run start -w @kumo/desktop      # run the build
```

## Your own scenes

Every `.js` or `.ts` file in `~/.kumo/scenes/` (or `$KUMO_HOME/scenes/`) is loaded as a scene script, and shows up in the scene gallery in Settings › Appearance next to the built-in ones. A file with an error gets a card you can't pick, with the error in its tooltip. A `.ts` file has its types stripped, nothing more: one file, no imports. That's also the place for scenes you can't redistribute: they never enter the app or the repository.

A scene is one `defineScene` call. The runtime owns the canvas and the loop; the scene draws and reacts:

```js
defineScene({
  id: "pulse",
  name: "Pulse",
  mount(ctx) {
    let glow = 0;
    return {
      frame(dt) {
        glow = Math.max(0, glow - dt);
        const [x, y] = ctx.target(); // the Workers panel, else the composer
        ctx.g.fillStyle = `rgba(95, 212, 244, ${0.15 + glow * 0.5})`;
        ctx.g.beginPath();
        ctx.g.arc(x, y, 60 + ctx.running * 20, 0, Math.PI * 2);
        ctx.g.fill();
      },
      onEvent(event) {
        if (event.type === "tool.completed") glow = 1;
      },
    };
  },
});
```

The full API (`resize`, `update` at a fixed 60 Hz step, `frame`, `render`, `onEvent`, `dispose`, and the context's theme, layout and activity) is typed in [`packages/scene-sdk`](../packages/scene-sdk/index.d.ts). To build a scene from TypeScript or several files, bundle it into one IIFE script first (for example `npx rolldown scene.ts --format iife --file ~/.kumo/scenes/scene.js`). The app reloads the scene page when a file in the folder is added, changed or removed.

## How it fits together

- **Engine:** runs in an Electron utility process, so a stuck provider CLI can't freeze the window. If it crashes it restarts, and the window reconnects. Quitting gives it a moment to close its sessions and their provider CLIs.
- **Window:** sandboxed, with context isolation and a strict CSP, and no browser permissions. The preload exposes only `kumo.invoke(command, args)` and `kumo.onEvent(cb)`, plus the folder picker, theme and window buttons. They run over a `MessagePort` to the engine, which validates every command against [`src/core/commands.js`](../src/core/commands.js); events follow [`src/core/events.js`](../src/core/events.js).
- **Scenes:** run in an iframe sandboxed to scripts only, served from their own `kumo-scene://` origin under a CSP with no network access. They get the theme, panel positions and a filtered activity feed (event types, tool names and models; never prompt or response text).
- **The bridge under Electron:** inside Electron, `process.execPath` is Electron itself, so [`src/core/node-command.js`](../src/core/node-command.js) adds `ELECTRON_RUN_AS_NODE=1` when launching the bridge. Configs that persist in a workspace use a system Node instead. The bridge removes the variable from its own environment as soon as it has started, and no child inherits it, so the worker CLIs and tools it launches start normally.
