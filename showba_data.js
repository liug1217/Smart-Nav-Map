// 小北百貨：13 家。由 tools/update-stores.js 產生，不要手動改(手動的店請加在 tools/stores-manual.json)
// 資料來源：© OpenStreetMap 貢獻者(ODbL)＋手動加入
// 精簡格式(tools/compact-data.js)，每筆：[經度, 緯度, 名稱]
window.showbaData = (function (k, rows) {
  return { type: 'FeatureCollection', features: rows.map(function (a) {
    var p = {};
    for (var i = 0; i < k.length; i++) if (a[i + 2] != null) p[k[i]] = a[i + 2];
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [a[0], a[1]] }, properties: p };
  }) };
})(["name"], [
[121.481428,25.080101,"小北百貨"],
[121.511841,24.997791,"小北百貨"],
[121.496183,24.993609,"小北百貨"],
[120.7033,24.09628,"小北百貨"],
[120.169176,22.990914,"小北百貨"],
[120.185816,22.983299,"小北百貨"],
[120.192434,22.961571,"小北百貨"],
[120.298052,22.72461,"小北百貨"],
[120.293267,22.710372,"小北百貨 軍校店"],
[120.302411,22.67637,"小北百貨"],
[120.292475,22.665516,"小北百貨"],
[120.305214,22.636709,"小北百貨"],
[120.345363,22.613006,"小北百貨"]
]);
