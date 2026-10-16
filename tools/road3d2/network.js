// 第 2 版 3D 道路引擎：路網
//   parseWays    OSM 道路(國道、快速道路、匝道)：方向統一成行車方向，記下車道數、橋梁、層、節點 id
//   buildChains  一段段的路接成完整的一條(每個節點挑「同樣是匝道 / 主線、轉彎最小」的配對)
//   prepChain    整條路等弧長取點(geom.resample)，每點帶屬性(車道數、橋、層、是不是匝道)與原始節點 id
'use strict';

const G = require('./geom');

function parseWays(elements) {
  const out = [], seen = new Set();
  for (const e of elements) {
    if (e.type !== 'way' || !e.geometry || e.geometry.length < 2 || !e.nodes || seen.has(e.id)) continue;
    seen.add(e.id);
    const t = e.tags || {};
    if (/^(yes|building_passage|culvert)$/.test(t.tunnel || '')) continue;   // 隧道不畫
    const hw = t.highway || '', link = /_link$/.test(hw), cls = hw.replace('_link', '');
    if (cls !== 'motorway' && cls !== 'trunk') continue;
    const coords = e.geometry.map((g) => [g.lon, g.lat]), nodes = e.nodes.slice();
    if (coords.length !== nodes.length) continue;
    const oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === '-1' || (t.oneway !== 'no' && (cls === 'motorway' || t.junction === 'roundabout'));
    if (t.oneway === '-1') { coords.reverse(); nodes.reverse(); }
    const lanesTag = parseInt(t.lanes, 10);
    const lanes = Math.max(1, Math.min(8, lanesTag > 0 ? lanesTag : (oneway ? (link ? 1 : cls === 'motorway' ? 3 : 2) : (link ? 2 : 4))));
    const bridge = !!t.bridge && t.bridge !== 'no';
    const layer = Math.max(0, Math.min(5, parseInt(t.layer, 10) || (bridge ? 1 : 0)));
    out.push({ id: e.id, cls, link, oneway, lanes, bridge, layer, coords, nodes, name: t.name || t.ref || '' });
  }
  return out;
}

function headingAt(w, atEnd) {
  const c = w.coords, a = atEnd ? c[c.length - 2] : c[0], b = atEnd ? c[c.length - 1] : c[1];
  const A = G.merc(a[0], a[1]), B = G.merc(b[0], b[1]);
  return Math.atan2(B[0] - A[0], B[1] - A[1]);
}
function buildChains(ways) {
  const ins = new Map(), outs = new Map();
  for (const w of ways) {
    const s = w.nodes[0], e = w.nodes[w.nodes.length - 1];
    if (!outs.has(s)) outs.set(s, []); outs.get(s).push(w);
    if (!ins.has(e)) ins.set(e, []); ins.get(e).push(w);
  }
  const next = new Map(), prev = new Map();
  for (const [node, list] of ins) {
    const o = outs.get(node);
    if (!o) continue;
    const pairs = [];
    for (const a of list) for (const b of o) {
      if (a === b || a.oneway !== b.oneway) continue;
      let d = Math.abs(headingAt(a, true) - headingAt(b, false)); if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > 60 * Math.PI / 180) continue;
      pairs.push({ a, b, score: d + (a.link === b.link ? 0 : 1) + (a.cls === b.cls ? 0 : 0.5) });
    }
    pairs.sort((x, y) => x.score - y.score);
    for (const p of pairs) if (!next.has(p.a) && !prev.has(p.b)) { next.set(p.a, p.b); prev.set(p.b, p.a); }
  }
  const chains = [], used = new Set();
  const walk = (start) => { const list = []; for (let w = start; w && !used.has(w); w = next.get(w)) { used.add(w); list.push(w); } return list; };
  for (const w of ways) if (!prev.has(w) && !used.has(w)) chains.push(walk(w));
  for (const w of ways) if (!used.has(w)) chains.push(walk(w));
  return chains.map((list, id) => {
    const pts = [], nodes = [], segWay = [];
    list.forEach((w, k) => {
      w.coords.forEach((c, i) => {
        if (k > 0 && i === 0) return;
        pts.push(G.merc(c[0], c[1])); nodes.push(w.nodes[i]);
        if (pts.length > 1) segWay.push(w);
      });
    });
    return { id, ways: list, pts, nodes, segWay, oneway: list[0].oneway, link: list.every((w) => w.link) };
  });
}

// 等弧長取點；每點屬性來自它所在的原始線段
function prepChain(ch) {
  const g = G.resample(ch.pts);
  ch.g = g;
  ch.attr = g.seg.map((i) => ch.segWay[Math.min(i, ch.segWay.length - 1)]);
  ch.node = new Array(g.P.length).fill(null);
  g.nodeAt.forEach((j, i) => { ch.node[j] = ch.nodes[i]; });
  return ch;
}

// 節點 id → 出現在哪些路的哪一點
function nodeIndex(chains) {
  const m = new Map();
  for (const ch of chains) ch.node.forEach((id, i) => { if (id == null) return; if (!m.has(id)) m.set(id, []); m.get(id).push({ ch, i }); });
  return m;
}

// 最小轉彎半徑(公尺)：原始資料常有幾公尺內左右折的小鋸齒，曲線會照畫成 S 形。照道路設計的下限把太急的地方平滑掉
// (匝道 30、快速道路 120、國道 250)。
// 交流道接點(好幾條路共用的節點)：歸「負責的那條路」(接點在它中間、主線優先、id 小的優先)，跟一般點一樣平滑，
// 平滑完其他路上的同一個節點跟著搬過去(接點不會斷開)，其他路再平滑一次(這時接點固定)
// 平滑包含兩件事：最小轉彎半徑、曲率不能突然跳(折角 < 0.5 度，不會有一折一折的感覺)
const MIN_R = { link: 30, trunk: 120, motorway: 250 };
// 節點歸屬：接點在它中間、主線優先、id 小的優先
function owners(chains, nodes) {
  const owner = new Map();
  for (const [id, list] of nodes) {
    if (list.length < 2) continue;
    const inner = list.filter((o) => o.i > 0 && o.i < o.ch.g.P.length - 1);
    const cand = (inner.length ? inner : list).slice().sort((a, b) => (a.ch.link - b.ch.link) || (a.ch.id - b.ch.id));
    owner.set(id, cand[0].ch);
  }
  return owner;
}
// 整個路網一起平滑：relax(ch, fixed) 先跑一輪(自己負責的接點可以動) → 接點同步 → 其他路再跑一輪(接點固定)
// only：只處理這些路(其他路的點只有接點會被同步)
function smoothNetwork(chains, relax, only) {
  const nodes = nodeIndex(chains), owner = owners(chains, nodes), todo = only ? chains.filter((c) => only.has(c)) : chains;
  let ok = true;
  const touched = new Set();
  for (const ch of todo) {
    const last = ch.g.P.length - 1;
    relax(ch, (i) => i === 0 || i === last || (ch.node[i] != null && owner.has(ch.node[i]) && owner.get(ch.node[i]) !== ch));
  }
  for (const [id, ch] of owner) {
    if (!todo.includes(ch)) continue;
    const own = nodes.get(id).find((o) => o.ch === ch);
    for (const o of nodes.get(id)) if (o.ch !== ch) { o.ch.g.P[o.i] = ch.g.P[own.i].slice(); touched.add(o.ch); }
  }
  for (const ch of new Set([...todo, ...touched])) {
    const last = ch.g.P.length - 1;
    G.refresh(ch.g);
    if (!relax(ch, (i) => i === 0 || i === last || (ch.node[i] != null && owner.has(ch.node[i])))) ok = false;
  }
  return ok;
}
function smoothChains(chains) {
  const stats = { smoothed: 0, failed: 0 };
  const need = (ch) => (i) => (ch.attr[i].link ? MIN_R.link : MIN_R[ch.attr[i].cls] || 120) / 1.2;
  let failed = 0;
  smoothNetwork(chains, (ch, fixed) => {
    const r = G.relaxCurvature(ch.g, need(ch), fixed, 200), r2 = G.relaxKinks(ch.g, fixed);
    if (r.passes || r2.passes) stats.smoothed++;
    if (!(r.ok && r2.ok)) failed++;
    return r.ok && r2.ok;
  });
  stats.failed = failed;
  return stats;
}

module.exports = { MIN_R, parseWays, buildChains, prepChain, nodeIndex, smoothChains, smoothNetwork };
