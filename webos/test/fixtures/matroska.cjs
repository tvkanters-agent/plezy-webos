const {deflateSync} = require('node:zlib');

function element(id, ...content) {
  const data = Buffer.concat(content);
  const size = Buffer.alloc(data.length < 0x1fffff ? 3 : 4);
  size.writeUIntBE(2 ** (7 * size.length) + data.length, 0, size.length);
  return Buffer.concat([Buffer.from(id, 'hex'), size, data]);
}

function uint(id, value) {
  const data = Buffer.alloc(4);
  data.writeUInt32BE(value);
  return element(id, data);
}

function assFixture(interval = 10000, format = 'ass', font) {
  const ass = format === 'ass';
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 384
PlayResY: 288

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${font ? 'Go Noto Current-Regular' : 'Arial'},28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1
`;
  const metadata = Buffer.concat([
    element('ec', Buffer.alloc(33000)),
    ...(font ? [element('1941a469', element('61a7', element('466e', Buffer.from('sign.ttf')), element('465c',font)))] : []),
    element('1549a966', uint('2ad7b1', 1000000)),
    element('1654ae6b', element('ae', uint('d7', 4), uint('83', 17),
      element('86', Buffer.from(ass ? 'S_TEXT/ASS' : 'S_TEXT/UTF8')),
      ...(ass ? [element('63a2', deflateSync(header)),
        element('6d80', element('6240', uint('5032', 3), element('5034', uint('4254', 0))))] : [])))
  ]);
  const clusters = [];
  const points = [];
  let offset = metadata.length;
  for (let i = 0; i < 18; i++) {
    const time = i * interval;
    const cluster = element('1f43b675', uint('e7', time), element('ec', Buffer.alloc(5000)),
      element('a0', element('a1', Buffer.from([0x84, 0, 10, 0]),
        ass ? deflateSync(`${i},0,Default,,0,0,0,,${font ? ['한','글'][i % 2] : 'Subtitle ' + i}`) : Buffer.from(`Subtitle ${i}`)),
      uint('9b', 1000)));
    clusters.push(cluster);
    points.push(element('bb', uint('b3', time + 10), element('b7', uint('f7', 4), uint('f1', offset))));
    offset += cluster.length;
  }
  const index = element('1c53bb6b', ...points);
  // Keep Cues before the first cluster, and correct the segment-relative offsets.
  for (const point of points) {
    const fieldOffset = point.length - 4;
    point.writeUInt32BE(point.readUInt32BE(fieldOffset) + index.length, fieldOffset);
  }
  const source = Buffer.concat([element('1a45dfa3'), element('18538067', metadata, element('1c53bb6b', ...points), ...clusters)]);
  const firstCluster = source.length - clusters.reduce((total, cluster) => total + cluster.length, 0);
  return {source, firstCluster, secondCluster:firstCluster + clusters[0].length,
    lastCluster:source.length - clusters[clusters.length - 1].length};
}

const srtFixture = interval => assFixture(interval, 'srt');

module.exports = {assFixture, srtFixture};
