# Desktop App

How the desktop app is put together, and how to run your own background scenes. Back to the [README](../README.md).

## What's in it

`apps/desktop` is an Electron app on the same engine as the CLI, Windows first. The shell and chat are done. The roles sheet, theme packages and project management are next.

- **Studio layout:** a glass title bar with the window buttons inside it, a sidebar with projects, chats and usage meters, the conversation, a glass composer, and a Workers panel that docks right, bottom, floating or hidden. A new chat opens on the "what should we build?" screen.
- **Glass over a live scene:** panels, messages and the composer are translucent and blurred over a background scene. The built-in scenes are **Clouds**, **Night sky** and **None** (grid only). They drift on their own, gather toward the Workers panel while workers run, and ripple when one finishes.
- **Light and dark** follow the system unless you pick one. Blur, glass opacity, scene, dock and grid are in the Appearance menu (the sliders button) and saved to `~/.kumo/desktop.json`. The OS "reduce transparency" and "reduce motion" settings are honored.
- **Window buttons** are round, in the title bar, and colored by the theme: `--win-close`, `--win-min` and `--win-max` in [`tokens.css`](../apps/desktop/src/renderer/src/styles/tokens.css), with their own values for light and dark. On macOS the native traffic lights move into the same spot.
- **Chat:** answers stream as Markdown, with each worker call shown where it happened, as a card with its model and time. Its live output streams into the Workers panel. Approvals appear as cards with a fixed amber strip that themes can't restyle. Chats resume with their provider conversation.

Run it from the repository (the root `npm install` installs the app through npm workspaces):

```powershell
npm run dev -w @kumo/desktop        # development, with hot reload
npm run build -w @kumo/desktop      # build to apps/desktop/out
npm run start -w @kumo/desktop      # run the build
```

## Your own scenes

Every `.js` file in `~/.kumo/scenes/` (or `$KUMO_HOME/scenes/`) is loaded as a scene script when the app starts, and shows up in the Appearance menu next to the built-in ones. That's also the place for scenes you can't redistribute: they never enter the app or the repository.

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

The full API (`resize`, `update` at a fixed 60 Hz step, `frame`, `render`, `onEvent`, `dispose`, and the context's theme, layout and activity) is typed in [`packages/scene-sdk`](../packages/scene-sdk/index.d.ts). To build a scene from TypeScript or several files, bundle it into one IIFE script first (for example `npx rolldown scene.ts --format iife --file ~/.kumo/scenes/scene.js`). Restart the app to pick up a new or changed file; hot reload comes with theme packages.

## How it fits together

- **Engine:** runs in an Electron utility process, so a stuck provider CLI can't freeze the window. If it crashes it restarts, and the window reconnects. Quitting gives it a moment to close its sessions and their provider CLIs.
- **Window:** sandboxed, with context isolation and a strict CSP, and no browser permissions. The preload exposes only `kumo.invoke(command, args)` and `kumo.onEvent(cb)`, plus the folder picker, theme and window buttons. They run over a `MessagePort` to the engine, which validates every command against [`src/core/commands.js`](../src/core/commands.js); events follow [`src/core/events.js`](../src/core/events.js).
- **Scenes:** run in an iframe sandboxed to scripts only, served from their own `kumo-scene://` origin under a CSP with no network access. They get the theme, panel positions and a filtered activity feed (event types, tool names and models; never prompt or response text).
- **The bridge under Electron:** inside Electron, `process.execPath` is Electron itself, so [`src/core/node-command.js`](../src/core/node-command.js) adds `ELECTRON_RUN_AS_NODE=1` when launching the bridge. Configs that persist in a workspace use a system Node instead.
