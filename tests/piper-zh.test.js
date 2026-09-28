const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const Z = require(path.join(__dirname, '..', 'tts', 'piper-zh.js'));

test('numbers are read the way a navigation voice says them', () => {
  assert.equal(Z.numbersToChinese('1公里後'), '一公里後');
  assert.equal(Z.numbersToChinese('900公尺'), '九百公尺');
  assert.equal(Z.numbersToChinese('限速60公里'), '限速六十公里');
  assert.equal(Z.numbersToChinese('限速110公里'), '限速一百一十公里');
  assert.equal(Z.numbersToChinese('200公尺'), '两百公尺');
  assert.equal(Z.numbersToChinese('2公里'), '两公里');
  assert.equal(Z.numbersToChinese('第2個出口'), '第二個出口');
  assert.equal(Z.numbersToChinese('1.5公里'), '一点五公里');
  assert.equal(Z.numbersToChinese('105公尺'), '一百零五公尺');
  assert.equal(Z.numbersToChinese('台1線'), '台一線');
});

test('traditional characters are converted before pinyin lookup', () => {
  assert.equal(Z.toSimplified('測速照相，通過，已到達目的地'), '测速照相，通过，已到达目的地');
  assert.equal(Z.toSimplified('沿著中正路'), '沿着中正路');
  assert.equal(Z.toSimplified('著名'), '著名');
});

test('phonemize splits pinyin into initial / final / tone like piper1-gpl', () => {
  // 假的 pinyin-pro：固定回傳「通过。」
  const fake = () => [
    { origin: '通', pinyin: 'tong1', isZh: true },
    { origin: '过', pinyin: 'guo4', isZh: true },
    { origin: '。', pinyin: '', isZh: false },
  ];
  assert.deepEqual(Z.phonemize('通過。', fake), [['t', 'ong', '1', 'g', 'uo', '4', '。']]);
  const zeroInitial = () => [{ origin: '二', pinyin: 'er4', isZh: true }, { origin: '的', pinyin: 'de0', isZh: true }];
  assert.deepEqual(Z.phonemize('二的', zeroInitial), [['Ø', 'er', '4', 'd', 'e', '5', '。']]);
});

test('phoneme ids: BOS, pad after each tone/punctuation group, EOS', () => {
  const idMap = { '^': [1], '$': [2], '_': [0], t: [9], ong: [38], '1': [64], '。': [69] };
  assert.deepEqual(Z.phonemesToIds(['t', 'ong', '1', '。'], idMap), [1, 9, 38, 64, 0, 69, 0, 2]);
});
