/*
 * Copyright (C) 2026 Elkan La Madrid
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/*
 * Kumo scene runtime. Runs inside the sandboxed scene iframe (opaque origin,
 * scripts only, no network), before any scene file; see scene-protocol.ts.
 *
 * A scene calls defineScene({ id, name, mount(ctx) }) and mount returns any of
 * { resize(w, h, dpr), update(step), frame(dt), render(), onEvent(e), dispose() }.
 * The runtime owns the canvas and the loop: it clears and draws the grid
 * each frame, runs update() at a fixed 60 Hz step (at most 4 per frame) and
 * frame()/render() once, pauses while the window is hidden, and draws a
 * single still frame when reduced motion is on (the OS setting, or the host's
 * theme.reducedMotion). The host can cap the frame rate (fps, 10-60); the
 * fixed-step update still advances by real elapsed time.
 *
 * The host sends theme, layout (where the Workers panel and composer are)
 * and a filtered activity feed — no prompt or response text.
 *
 * On the page /thumb?src=&mode=&accent= (gallery cards) only one scene script
 * is loaded: the runtime mounts it by itself, grid off, at 24 fps at most.
 */
(function () {
  "use strict";
  var STEP = 1 / 60;
  var THUMB_FPS = 24;
  var registry = new Map();
  var thumb = location.pathname === "/thumb";

  self.defineScene = function (def) {
    if (def && typeof def.id === "string" && typeof def.mount === "function") registry.set(def.id, def);
    return def;
  };

  var canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;display:block";
  document.body.appendChild(canvas);
  var g = canvas.getContext("2d");
  var motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  // Reduced motion is on when either the OS or the host asks for it.
  var motion = { os: motionQuery.matches, host: false };

  var state = {
    theme: { mode: "dark", grid: true, accent: "#5FD4F4" },
    layout: { workers: null, composer: null },
    running: 0,
    reducedMotion: motionQuery.matches,
  };
  var inst = null;
  var raf = 0;
  var last = 0;
  var fps = 0; // 0: not capped, render on every animation frame
  var lastRender = 0;
  var acc = 0;
  var W = 0;
  var H = 0;
  var dpr = 1;
  var frames = 0;
  var busyMs = 0;
  var statsAt = 0;

  function seeded(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var ctx = {
    canvas: canvas,
    g: g,
    random: seeded,
    get width() { return W; },
    get height() { return H; },
    get dpr() { return dpr; },
    get theme() { return state.theme; },
    get layout() { return state.layout; },
    get running() { return state.running; },
    get reducedMotion() { return state.reducedMotion; },
    /** Where activity happens: the Workers panel, else the composer, else the middle. */
    target: function () {
      var r = state.layout.workers || state.layout.composer;
      return r ? [r.x + r.w / 2, r.y + r.h / 2] : [W / 2, H / 2];
    },
  };

  function post(message) {
    message.kumo = 1;
    parent.postMessage(message, "*");
  }

  function report(err) {
    post({ type: "error", message: String((err && err.message) || err) });
  }

  /** Returns whether the effective reduced-motion setting changed. */
  function setReducedMotion() {
    var next = motion.os || motion.host;
    if (next === state.reducedMotion) return false;
    state.reducedMotion = next;
    return true;
  }

  function setFps(value) {
    if (typeof value === "number" && isFinite(value)) fps = Math.min(60, Math.max(10, Math.round(value)));
  }

  function resize() {
    dpr = Math.min(2, self.devicePixelRatio || 1);
    W = self.innerWidth;
    H = self.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (inst && inst.resize) {
      try { inst.resize(W, H, dpr); } catch (e) { report(e); }
    }
    if (state.reducedMotion || document.hidden) render(0);
  }

  function drawGrid() {
    if (!state.theme.grid) return;
    var cell = 14;
    g.strokeStyle = state.theme.mode === "dark" ? "rgba(150,180,230,0.05)" : "rgba(20,40,80,0.06)";
    g.lineWidth = 1;
    g.beginPath();
    for (var x = 0.5; x < W; x += cell) { g.moveTo(x, 0); g.lineTo(x, H); }
    for (var y = 0.5; y < H; y += cell) { g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
  }

  function render(dt) {
    var t0 = performance.now();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    drawGrid();
    if (inst) {
      try {
        if (inst.update) {
          acc += dt;
          var n = 0;
          // A low fps cap makes dt (at most 0.1 s) cover more steps than 4.
          var most = Math.max(4, Math.ceil(1 / ((fps || 60) * STEP)) + 1);
          while (acc >= STEP && n < most) { inst.update(STEP); acc -= STEP; n++; }
          if (n === most) acc = 0;
        }
        if (inst.frame) inst.frame(dt);
        if (inst.render) inst.render();
      } catch (e) {
        report(e);
        inst = null;
      }
    }
    busyMs += performance.now() - t0;
    frames++;
  }

  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (fps) {
      // Skip frames until one fps-th of a second has passed (1 ms of slack for
      // timer jitter). Snapping to the frame grid keeps the average at the cap.
      var gap = 1000 / fps;
      var since = ts - lastRender;
      if (lastRender && since < gap - 1) return;
      lastRender = !lastRender || since < gap ? ts : ts - (since % gap);
    }
    var dt = last ? Math.min(0.1, (ts - last) / 1000) : STEP;
    last = ts;
    render(dt);
    if (ts - statsAt > 2000) {
      post({ type: "stats", avgMs: busyMs / Math.max(1, frames), frames: frames });
      busyMs = 0;
      frames = 0;
      statsAt = ts;
    }
  }

  function start() {
    cancelAnimationFrame(raf);
    last = 0;
    lastRender = 0;
    if (state.reducedMotion || document.hidden) {
      render(0);
      return;
    }
    raf = requestAnimationFrame(loop);
  }

  function mount(id) {
    if (inst && inst.dispose) {
      try { inst.dispose(); } catch (e) { report(e); }
    }
    inst = null;
    var def = registry.get(id);
    if (def) {
      try { inst = def.mount(ctx) || null; } catch (e) { report(e); }
    }
    resize();
    start();
  }

  function deliver(event) {
    if (event.type === "tool.started") state.running++;
    else if (event.type === "tool.completed") state.running = Math.max(0, state.running - 1);
    else if (event.type === "turn.completed" || event.type === "turn.failed") state.running = 0;
    if (inst && inst.onEvent) {
      try { inst.onEvent(event); } catch (e) { report(e); }
    }
  }

  self.addEventListener("error", function (e) { report(e.error || e.message); });
  self.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", start);
  motionQuery.addEventListener("change", function (e) {
    motion.os = e.matches;
    if (setReducedMotion()) start();
  });

  self.addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || m.kumo !== 1) return;
    if (m.type === "init") {
      if (m.theme) {
        state.theme = m.theme;
        motion.host = m.theme.reducedMotion === true;
        setReducedMotion();
      }
      if (m.layout) state.layout = m.layout;
      setFps(m.fps);
      mount(m.scene);
    } else if (m.type === "scene") {
      mount(m.scene);
    } else if (m.type === "theme") {
      state.theme = m.theme;
      motion.host = !!m.theme && m.theme.reducedMotion === true;
      var motionChanged = setReducedMotion();
      deliver({ type: "theme", theme: m.theme });
      if (motionChanged) start();
      else if (state.reducedMotion || document.hidden) render(0);
    } else if (m.type === "fps") {
      setFps(m.fps);
    } else if (m.type === "layout") {
      state.layout = m.layout;
      deliver({ type: "layout", layout: m.layout });
    } else if (m.type === "event" && m.event && typeof m.event.type === "string") {
      deliver(m.event);
    }
  });

  /** Gallery card: the one scene this page loaded, themed by the query string. */
  function mountThumb() {
    var query = new URLSearchParams(location.search);
    var accent = query.get("accent");
    state.theme = {
      mode: query.get("mode") === "light" ? "light" : "dark",
      grid: false,
      accent: /^[0-9a-fA-F]{3,8}$/.test(accent || "") ? "#" + accent : state.theme.accent,
    };
    fps = THUMB_FPS;
    var first = registry.values().next();
    if (!first.done) mount(first.value.id);
  }

  // Every scene script has run by now: they're classic scripts after this one.
  document.addEventListener("DOMContentLoaded", function () {
    var scenes = [];
    registry.forEach(function (def) {
      scenes.push({ id: def.id, name: typeof def.name === "string" && def.name ? def.name : def.id });
    });
    if (thumb) mountThumb();
    post({ type: "ready", scenes: scenes });
  });
})();
