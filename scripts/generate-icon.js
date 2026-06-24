// Generates build/icon.png (512x512) and build/icon.ico for packaging.
// A simple "termi" mark: dark rounded square + blue prompt ">_".
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const pngToIcoMod = require('png-to-ico');
const pngToIco = pngToIcoMod.default || pngToIcoMod;

const OUT = path.join(__dirname, '..', 'build');
const SIZE = 512;
const BG = 0x161b22ff;     // dark panel
const ACCENT = 0x58a6ffff; // blue
const RADIUS = 96;

function rounded(img) {
  // carve rounded corners (set alpha 0 outside the radius)
  img.scan(0, 0, SIZE, SIZE, function (x, y, idx) {
    let dx = -1, dy = -1;
    if (x < RADIUS && y < RADIUS) { dx = RADIUS - x; dy = RADIUS - y; }
    else if (x >= SIZE - RADIUS && y < RADIUS) { dx = x - (SIZE - RADIUS - 1); dy = RADIUS - y; }
    else if (x < RADIUS && y >= SIZE - RADIUS) { dx = RADIUS - x; dy = y - (SIZE - RADIUS - 1); }
    else if (x >= SIZE - RADIUS && y >= SIZE - RADIUS) { dx = x - (SIZE - RADIUS - 1); dy = y - (SIZE - RADIUS - 1); }
    if (dx >= 0 && dy >= 0 && (dx * dx + dy * dy) > RADIUS * RADIUS) {
      this.bitmap.data[idx + 3] = 0;
    }
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const img = new Jimp(SIZE, SIZE, BG);

  // accent frame
  const border = 14;
  img.scan(0, 0, SIZE, SIZE, function (x, y, idx) {
    if (x < border || y < border || x >= SIZE - border || y >= SIZE - border) {
      this.bitmap.data[idx] = (ACCENT >>> 24) & 0xff;
      this.bitmap.data[idx + 1] = (ACCENT >>> 16) & 0xff;
      this.bitmap.data[idx + 2] = (ACCENT >>> 8) & 0xff;
      this.bitmap.data[idx + 3] = 0xff;
    }
  });

  // prompt ">_" drawn as crisp vector strokes (full control of alignment)
  const COL = Jimp.cssColorToHex('#58a6ff');
  function dot(cx, cy, r) {
    for (let yy = -r; yy <= r; yy++) {
      for (let xx = -r; xx <= r; xx++) {
        if (xx * xx + yy * yy <= r * r) {
          const px = cx + xx, py = cy + yy;
          if (px >= 0 && py >= 0 && px < SIZE && py < SIZE) img.setPixelColor(COL, px, py);
        }
      }
    }
  }
  function stroke(x0, y0, x1, y1, r) {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      dot(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), r);
    }
  }

  const R = 19;
  // chevron ">" on top, centered (top -> apex -> bottom)
  stroke(212, 158, 300, 224, R);
  stroke(300, 224, 212, 290, R);
  // underscore "_" directly below, centered under the chevron
  stroke(206, 352, 306, 352, R);

  rounded(img);

  const pngPath = path.join(OUT, 'icon.png');
  await img.writeAsync(pngPath);
  const icoBuf = await pngToIco(pngPath);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), icoBuf);
  console.log('icon written to', OUT);
})();
