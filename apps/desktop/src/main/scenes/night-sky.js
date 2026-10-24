/*
 * Night sky: glyph stars twinkle across the window. While workers run, the
 * stars near the Workers panel brighten and comets streak toward it; a
 * finished worker sends out a ring of light.
 */
defineScene({
  id: "stars",
  name: "Night sky",
  mount: function (ctx) {
    var CELL = 14;
    var g = ctx.g;
    var stars = [];
    var comets = [];
    var rings = [];
    var t = 0;
    var cometClock = 0;

    function palette() {
      var dark = ctx.theme.mode === "dark";
      return {
        dark: dark,
        ink: dark ? [225, 235, 250] : [16, 26, 46],
        hues: dark
          ? [[122, 162, 247], [95, 212, 244], [187, 154, 247], [140, 160, 190]]
          : [[47, 111, 235], [14, 140, 170], [120, 90, 200], [90, 105, 130]],
      };
    }

    function init() {
      stars = [];
      for (var i = 0; i < 170; i++) {
        stars.push({ x: Math.random() * ctx.width, y: Math.random() * ctx.height, phase: Math.random() * 6.28, speed: 0.6 + Math.random() * 1.8, kind: Math.random() });
      }
      comets = [];
      rings = [];
    }

    function tile(p, cx, cy, glyph, rgb, a, ga) {
      var x = cx * CELL;
      var y = cy * CELL;
      if (a > 0) {
        g.fillStyle = "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + a.toFixed(3) + ")";
        g.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
      }
      g.fillStyle = "rgba(" + p.ink[0] + "," + p.ink[1] + "," + p.ink[2] + "," + Math.min(1, ga).toFixed(3) + ")";
      g.fillText(glyph, x + CELL / 2, y + CELL / 2 + 0.5);
    }

    init();

    return {
      resize: init,
      onEvent: function (e) {
        if (e.type === "tool.completed") {
          var tg = ctx.target();
          rings.push({ x: tg[0], y: tg[1], r: 0, life: 1 });
        }
      },
      frame: function (dt) {
        var p = palette();
        var tg = ctx.target();
        var tx = tg[0];
        var ty = tg[1];
        var running = ctx.running > 0;
        t += dt;

        g.font = '500 10px "JetBrains Mono", monospace';
        g.textAlign = "center";
        g.textBaseline = "middle";

        for (var i = 0; i < stars.length; i++) {
          var s = stars[i];
          var near = running ? Math.max(0, 1 - Math.hypot(s.x - tx, s.y - ty) / 320) : 0;
          var twinkle = 0.5 + 0.5 * Math.sin(t * s.speed + s.phase);
          var glyph = s.kind > 0.92 ? "*" : s.kind > 0.7 ? "+" : ".";
          var gx = Math.floor(s.x / CELL);
          var gy = Math.floor(s.y / CELL);
          var bright = s.kind > 0.92 || near > 0.4;
          var a = bright ? (p.dark ? 0.13 : 0.12) + near * 0.25 : 0;
          tile(p, gx, gy, glyph, p.hues[(gx + gy) % 4], a, (p.dark ? 0.15 : 0.18) + twinkle * 0.45 + near * 0.4);
        }

        cometClock -= dt;
        if (running && cometClock <= 0) {
          cometClock = 0.9;
          var edge = Math.random() * (ctx.width + ctx.height);
          comets.push(edge < ctx.width ? { x: edge, y: 0, life: 1 } : { x: Math.random() < 0.5 ? 0 : ctx.width, y: edge - ctx.width, life: 1 });
        }
        for (var c = comets.length - 1; c >= 0; c--) {
          var cm = comets[c];
          var step = Math.min(1, dt * 1.6);
          cm.x += (tx - cm.x) * step;
          cm.y += (ty - cm.y) * step;
          cm.life -= dt * 0.7;
          if (cm.life <= 0 || Math.hypot(tx - cm.x, ty - cm.y) < 10) { comets.splice(c, 1); continue; }
          tile(p, Math.floor(cm.x / CELL), Math.floor(cm.y / CELL), "*", p.hues[1], 0.18 * cm.life, 0.85 * cm.life);
        }

        for (var r = rings.length - 1; r >= 0; r--) {
          var rg = rings[r];
          rg.r += dt * 260;
          rg.life -= dt * 0.8;
          if (rg.life <= 0) { rings.splice(r, 1); continue; }
          var steps = Math.max(12, Math.floor(rg.r / 6));
          for (var k = 0; k < steps; k++) {
            var ang = (k / steps) * Math.PI * 2;
            tile(p, Math.floor((rg.x + Math.cos(ang) * rg.r) / CELL), Math.floor((rg.y + Math.sin(ang) * rg.r) / CELL), "+", p.hues[1], 0.1 * rg.life, 0.7 * rg.life);
          }
        }
      },
    };
  },
});
