/*
 * Clouds: cumulus made of tinted glyph tiles drift across the window. While
 * workers run they gather around the Workers panel and shed wisps toward it;
 * a finished worker sends out a ripple.
 */
defineScene({
  id: "clouds",
  name: "Clouds",
  mount: function (ctx) {
    var CELL = 14;
    var GLYPHS = " .'-:=+*%#S8@";
    var g = ctx.g;
    var clouds = [];
    var currents = [];
    var parts = [];
    var ripples = [];
    var t = 0;

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

    function hash(x, y) {
      var n = (x * 374761393 + y * 668265263) | 0;
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
    }

    function init() {
      var W = ctx.width;
      var H = ctx.height;
      var rnd = Math.random;
      clouds = [];
      for (var i = 0; i < 7; i++) {
        var r = 50 + rnd() * 70;
        var blobs = [];
        var n = 4 + Math.floor(rnd() * 3);
        for (var b = 0; b < n; b++) {
          blobs.push({ dx: (b - n / 2) * r * 0.45 + (rnd() - 0.5) * r * 0.3, dy: (rnd() - 0.6) * r * 0.45, r: r * (0.45 + rnd() * 0.4) });
        }
        var base = 7 + rnd() * 9;
        clouds.push({ x: rnd() * W, y: 60 + rnd() * Math.max(1, H - 160), vx: base, vy: 0, base: base, blobs: blobs, hue: i % 4, phase: rnd() * 6.28, span: r * 1.6 });
      }
      currents = [];
      for (var k = 0; k < 26; k++) currents.push({ x: rnd() * W, y: rnd() * H, n: 2 + Math.floor(rnd() * 4), v: 10 + rnd() * 18 });
      parts = [];
      ripples = [];
    }

    function tile(p, cx, cy, glyph, rgb, a, ga) {
      var x = cx * CELL;
      var y = cy * CELL;
      g.fillStyle = "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + a.toFixed(3) + ")";
      g.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
      if (glyph !== " ") {
        g.fillStyle = "rgba(" + p.ink[0] + "," + p.ink[1] + "," + p.ink[2] + "," + ga.toFixed(3) + ")";
        g.fillText(glyph, x + CELL / 2, y + CELL / 2 + 0.5);
      }
    }

    init();

    return {
      resize: init,
      onEvent: function (e) {
        if (e.type === "tool.completed") {
          var tg = ctx.target();
          ripples.push({ x: tg[0], y: tg[1], r: 0, life: 1 });
        }
      },
      frame: function (dt) {
        var W = ctx.width;
        var H = ctx.height;
        var p = palette();
        var tg = ctx.target();
        var tx = tg[0];
        var ty = tg[1];
        var running = ctx.running > 0;
        t += dt;

        g.font = '500 10px "JetBrains Mono", monospace';
        g.textAlign = "center";
        g.textBaseline = "middle";

        for (var i = 0; i < currents.length; i++) {
          var cu = currents[i];
          cu.x += cu.v * dt;
          if (cu.x > W + 60) { cu.x = -60; cu.y = Math.random() * H; }
          g.fillStyle = "rgba(" + p.ink[0] + "," + p.ink[1] + "," + p.ink[2] + "," + (p.dark ? 0.22 : 0.28) + ")";
          for (var k = 0; k < cu.n; k++) g.fillText("-", Math.round((cu.x + k * 10) / CELL) * CELL + CELL / 2, Math.round(cu.y / CELL) * CELL + CELL / 2);
        }

        for (var c = 0; c < clouds.length; c++) {
          var cl = clouds[c];
          var wantX = cl.base;
          var wantY = Math.sin(t * 0.25 + cl.phase) * 5;
          if (running) {
            var dx = tx - cl.x;
            var dy = ty - cl.y;
            var d = Math.max(1, Math.hypot(dx, dy));
            var pull = d > cl.span * 0.9 ? 38 : 6;
            wantX = (dx / d) * pull - (dy / d) * 13;
            wantY = (dy / d) * pull + (dx / d) * 13;
          }
          cl.vx += (wantX - cl.vx) * Math.min(1, dt * 0.9);
          cl.vy += (wantY - cl.vy) * Math.min(1, dt * 0.9);
          cl.x += cl.vx * dt;
          cl.y += cl.vy * dt;
          if (cl.x - cl.span > W + 40) cl.x = -cl.span - 40;
          if (cl.x + cl.span < -80) cl.x = W + cl.span;
          cl.y = Math.max(-40, Math.min(H + 40, cl.y));

          var x0 = Math.floor((cl.x - cl.span) / CELL);
          var x1 = Math.ceil((cl.x + cl.span) / CELL);
          var y0 = Math.floor((cl.y - cl.span * 0.8) / CELL);
          var y1 = Math.ceil((cl.y + cl.span * 0.6) / CELL);
          var rgb = p.hues[cl.hue];
          for (var gy = y0; gy <= y1; gy++) {
            for (var gx = x0; gx <= x1; gx++) {
              var px = gx * CELL + CELL / 2;
              var py = gy * CELL + CELL / 2;
              var dens = 0;
              for (var b = 0; b < cl.blobs.length; b++) {
                var bl = cl.blobs[b];
                var q = 1 - Math.hypot(px - (cl.x + bl.dx), py - (cl.y + bl.dy)) / bl.r;
                if (q > dens) dens = q;
              }
              if (dens <= 0.02) continue;
              var h = hash(gx, gy + Math.floor(t * 1.5));
              if (dens < 0.18 && h > 0.55) continue;
              var gi = Math.min(GLYPHS.length - 1, Math.floor(dens * GLYPHS.length * 1.15 + h * 2));
              tile(p, gx, gy, GLYPHS[gi], rgb, p.dark ? 0.06 + dens * 0.32 : 0.05 + dens * 0.22, p.dark ? 0.18 + dens * 0.55 : 0.2 + dens * 0.55);
            }
          }
          if (running && Math.random() < dt * 2.2) {
            parts.push({ x: cl.x + (Math.random() - 0.5) * cl.span, y: cl.y + (Math.random() - 0.5) * cl.span * 0.5, life: 1, hue: cl.hue });
          }
        }

        for (var j = parts.length - 1; j >= 0; j--) {
          var pt = parts[j];
          var step = Math.min(1, dt * 1.3);
          pt.x += (tx - pt.x) * step;
          pt.y += (ty - pt.y) * step;
          pt.life -= dt * 0.55;
          if (pt.life <= 0 || Math.hypot(tx - pt.x, ty - pt.y) < 10) { parts.splice(j, 1); continue; }
          tile(p, Math.floor(pt.x / CELL), Math.floor(pt.y / CELL), "'", p.hues[pt.hue], 0.18 * pt.life, 0.8 * pt.life);
        }

        for (var r = ripples.length - 1; r >= 0; r--) {
          var rp = ripples[r];
          rp.r += dt * 260;
          rp.life -= dt * 0.8;
          if (rp.life <= 0) { ripples.splice(r, 1); continue; }
          var steps = Math.max(12, Math.floor(rp.r / 6));
          for (var s = 0; s < steps; s++) {
            var ang = (s / steps) * Math.PI * 2;
            tile(p, Math.floor((rp.x + Math.cos(ang) * rp.r) / CELL), Math.floor((rp.y + Math.sin(ang) * rp.r) / CELL), "o", p.hues[1], 0.12 * rp.life, 0.7 * rp.life);
          }
        }
      },
    };
  },
});
