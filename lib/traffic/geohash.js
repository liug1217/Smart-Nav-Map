// Geohash encode/decode and heading → direction helpers.

const GH32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function ghEncode(lat, lng, precision) {
  let idx = 0, bit = 0, even = true;
  let laMin = -90, laMax = 90, lnMin = -180, lnMax = 180, hash = '';
  while (hash.length < precision) {
    if (even) {
      const m = (lnMin + lnMax) / 2;
      if (lng >= m) { idx = (idx << 1) | 1; lnMin = m; } else { idx <<= 1; lnMax = m; }
    } else {
      const m = (laMin + laMax) / 2;
      if (lat >= m) { idx = (idx << 1) | 1; laMin = m; } else { idx <<= 1; laMax = m; }
    }
    even = !even;
    if (++bit === 5) { hash += GH32[idx]; idx = 0; bit = 0; }
  }
  return hash;
}

function ghDecode(hash) {
  let even = true, laMin = -90, laMax = 90, lnMin = -180, lnMax = 180;
  for (const c of hash) {
    const bits = GH32.indexOf(c);
    for (let i = 4; i >= 0; i--) {
      const b = (bits >> i) & 1;
      if (even) { const m = (lnMin + lnMax) / 2; if (b) lnMin = m; else lnMax = m; }
      else       { const m = (laMin + laMax) / 2; if (b) laMin = m; else laMax = m; }
      even = !even;
    }
  }
  return { lat: (laMin + laMax) / 2, lng: (lnMin + lnMax) / 2 };
}

// Maps heading (degrees) to one of N/E/S/W to separate bidirectional traffic.
// 'U' = unknown (heading not provided).
function headingToDir(h) {
  if (typeof h !== 'number' || isNaN(h)) return 'U';
  const deg = ((h % 360) + 360) % 360;
  if (deg >= 315 || deg < 45)  return 'N';
  if (deg >= 45  && deg < 135) return 'E';
  if (deg >= 135 && deg < 225) return 'S';
  return 'W';
}

// Haversine distance in km between two lat/lng points.
function haversineKm(la1, ln1, la2, ln2) {
  const R = 6371, d2r = Math.PI / 180;
  const dLa = (la2 - la1) * d2r, dLn = (ln2 - ln1) * d2r;
  const a = Math.sin(dLa / 2) ** 2 +
            Math.cos(la1 * d2r) * Math.cos(la2 * d2r) * Math.sin(dLn / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = { ghEncode, ghDecode, headingToDir, haversineKm };
