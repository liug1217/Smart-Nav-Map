// 地圖資料檔(*_data.js)的精簡格式：每筆只存 [經度, 緯度, 屬性1, 屬性2…]，網頁載入時再還原成 GeoJSON。
// 跟每筆都寫一次 {type:'Feature',geometry:{…},properties:{…}} 比，檔案小一半、手機解讀快約 3 倍。
// 網頁拿到的 window.<變數> 還是原本的 FeatureCollection，用到資料的程式都不用改。

// keys：屬性名稱(依序對應每筆第 3 個以後的欄位)；features：GeoJSON Point features
function compactJs(varName, keys, features) {
  const rows = features.map(f => {
    const p = f.properties || {};
    const r = [f.geometry.coordinates[0], f.geometry.coordinates[1]].concat(keys.map(k => (p[k] === undefined ? null : p[k])));
    while (r.length > 2 && r[r.length - 1] === null) r.pop(); // 後面沒有值的欄位不寫
    return r;
  });
  return `window.${varName} = (function (k, rows) {\n` +
    `  return { type: 'FeatureCollection', features: rows.map(function (a) {\n` +
    `    var p = {};\n` +
    `    for (var i = 0; i < k.length; i++) if (a[i + 2] != null) p[k[i]] = a[i + 2];\n` +
    `    return { type: 'Feature', geometry: { type: 'Point', coordinates: [a[0], a[1]] }, properties: p };\n` +
    `  }) };\n` +
    `})(${JSON.stringify(keys)}, [\n${rows.map(r => JSON.stringify(r)).join(',\n')}\n]);\n`;
}

module.exports = { compactJs };
