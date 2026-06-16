"use strict";
// Build lib/worldcodes.json : GeoNames id -> K-Weather world city code, by matching each
// catalog city to the nearest K-Weather world city (kw-code-world1) within a distance
// threshold. Source list: .secrets/worldcat.json (fetched once from /api/worldcat).
//   node scripts/build-worldcodes.cjs [maxKm]
const fs = require("fs");
const path = require("path");

const MAX_KM = Number(process.argv[2] || 35);
const CITIES = require("../lib/cities.json"); // [id, name, cc, lat, lon]
const WORLD = require("../.secrets/worldcat.json"); // { code: {city,country,lat,lon} }

const world = Object.entries(WORLD).map(([code, v]) => ({ code: Number(code), city: v.city, country: v.country, lat: v.lat, lon: v.lon }));

function distKm(la1, lo1, la2, lo2) {
  const R = 6371, toR = (x) => (x * Math.PI) / 180;
  const dLa = toR(la2 - la1), dLo = toR(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const map = {};
const samples = [];
let matched = 0;
for (const [id, name, cc, lat, lon] of CITIES) {
  let best = null, bestD = Infinity;
  for (const w of world) {
    if (Math.abs(w.lat - lat) > 0.6 || Math.abs(w.lon - lon) > 0.6) continue; // cheap prefilter
    const d = distKm(lat, lon, w.lat, w.lon);
    if (d < bestD) { bestD = d; best = w; }
  }
  if (best && bestD <= MAX_KM) {
    map[id] = best.code;
    matched++;
    if (samples.length < 25) samples.push(`${name},${cc} -> ${best.city || "?"} (${best.code}) ${bestD.toFixed(1)}km`);
  }
}

fs.writeFileSync(path.join(__dirname, "..", "lib", "worldcodes.json"), JSON.stringify(map));
console.log(`catalog ${CITIES.length} | world ${world.length} | matched ${matched} (<=${MAX_KM}km) -> lib/worldcodes.json`);
console.log("samples:");
for (const s of samples) console.log("  ", s);
