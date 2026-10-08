const assert = require('node:assert/strict');
const test = require('node:test');
const { cutIntoCells, parseWkt, LEVEL_BY_OFFICIAL } = require('../lib/traffic/freeway');
const { ghDecode } = require('../lib/traffic/geohash');

test('WKT LINESTRING and MULTILINESTRING are parsed into [lng, lat] lines', () => {
  assert.deepEqual(parseWkt('LINESTRING(121.1 25.1,121.2 25.2)'), [[[121.1, 25.1], [121.2, 25.2]]]);
  const multi = parseWkt('MULTILINESTRING((121.1 25.1,121.2 25.2),(121.3 25.3,121.4 25.4))');
  assert.equal(multi.length, 2);
  assert.deepEqual(multi[1][0], [121.3, 25.3]);
});

test('a 2 km southbound freeway line is cut into ~150 m geohash cells, all heading S, continuous', () => {
  const line = [[121.5, 25.10], [121.5, 25.082]]; // 往南約 2 公里
  const cells = cutIntoCells(line);
  assert.ok(cells.length >= 10 && cells.length <= 20, 'cells: ' + cells.length);
  cells.forEach(c => {
    assert.equal(c.dir, 'S');
    assert.ok(c.coords.length >= 2);
    const b = ghDecode(c.gh);
    assert.ok(Math.abs(b.lat - c.coords[1][1]) < 0.002, 'cell matches its coordinates');
  });
  // 每一格的起點 = 前一格的終點：線是連續的，不會斷
  for (let i = 1; i < cells.length; i++) assert.deepEqual(cells[i].coords[0], cells[i - 1].coords[cells[i - 1].coords.length - 1]);
});

test('official congestion levels map to our five levels; 0 (no data) is not shown', () => {
  assert.equal(LEVEL_BY_OFFICIAL[1], 'free');
  assert.equal(LEVEL_BY_OFFICIAL[2], 'moderate');
  assert.equal(LEVEL_BY_OFFICIAL[3], 'slow');
  assert.equal(LEVEL_BY_OFFICIAL[4], 'congested');
  assert.equal(LEVEL_BY_OFFICIAL[5], 'severe');
  assert.equal(LEVEL_BY_OFFICIAL[0], undefined);
});

test('Taipei sections: only busy/jammed ones are kept, cut into cells along start→end; bad coordinates dropped', () => {
  const { parse } = require('../lib/traffic/taipei');
  const sec = (id, lv, spd, x1, y1, x2, y2) => `<vd:SectionData><vd:SectionId>${id}</vd:SectionId><vd:SectionName>光復北路  健康路-南京東路</vd:SectionName>` +
    `<vd:AvgSpd>${spd}</vd:AvgSpd><vd:MOELevel>${lv}</vd:MOELevel><vd:StartWgsX>${x1}</vd:StartWgsX><vd:StartWgsY>${y1}</vd:StartWgsY>` +
    `<vd:EndWgsX>${x2}</vd:EndWgsX><vd:EndWgsY>${y2}</vd:EndWgsY></vd:SectionData>`;
  const xml = sec('A', 2, 18.4, 121.5566, 25.0537, 121.5573, 25.0515) +   // 壅塞、往南約 250 公尺
              sec('B', 0, 50, 121.50, 25.06, 121.51, 25.06) +             // 順暢：不送
              sec('C', 1, 30, 121.50, 25.06, 140.0, 35.0) +               // 座標錯誤(上千公里)：不用
              sec('D', -1, 40, 121.50, 25.06, 121.501, 25.06);            // 沒資料
  const cells = parse(xml);
  assert.ok(cells.length >= 1 && cells.length <= 4, 'cells: ' + cells.length);
  cells.forEach(c => { assert.equal(c.level, 'congested'); assert.equal(c.speed, 18); assert.equal(c.dir, 'S'); assert.equal(c.name, '光復北路 健康路-南京東路'); });
});

test('Taoyuan detectors: speed is the volume-weighted lane average; broken lanes ignored; free flow not sent', () => {
  const { parseDevices, parseLive, levelFromKmh } = require('../lib/traffic/taoyuan');
  const dev = parseDevices('<VD><VDID>V1</VDID><PositionLon>121.31</PositionLon><PositionLat>25.0</PositionLat><RoadName>春日路</RoadName></VD>' +
                           '<VD><VDID>V2</VDID><PositionLon>121.32</PositionLon><PositionLat>25.01</PositionLat><RoadName>中山路</RoadName></VD>');
  const row = (id, lane, sp, type, vol, status = 0) => `<VDLive><VDID>${id}</VDID><LaneID>${lane}</LaneID><LaneSpeed>${sp}</LaneSpeed><VehicleType>${type}</VehicleType><Volume>${vol}</Volume><Status>${status}</Status></VDLive>`;
  const xml = row('V1', 0, 10, 'S', 30) + row('V1', 0, 10, 'M', 10) +   // 車道 0：10 km/h，車流 40
              row('V1', 1, 30, 'S', 10) +                              // 車道 1：30 km/h，車流 10 → 加權 (10×40+30×10)/50 = 14
              row('V1', 2, 90, 'S', 99, 1) +                           // 故障車道：不算
              row('V2', 0, 50, 'S', 20);                               // 順暢：不送
  const pts = parseLive(xml, dev);
  assert.equal(pts.length, 1);
  assert.equal(pts[0].speed, 14);
  assert.equal(pts[0].level, 'slow');
  assert.equal(pts[0].road, '春日路');
  assert.equal(levelFromKmh(35), 'free');
  assert.equal(levelFromKmh(25), 'moderate');
  assert.equal(levelFromKmh(8), 'congested');
});
