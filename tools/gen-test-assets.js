// 生成合规测试资产：120x120 PNG（验 vision）+ 1秒 16kHz WAV（验 asr）
const fs = require('fs');
const zlib = require('zlib');

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function makePNG(w, h) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8]=8; ihdr[9]=2; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;
  const rowLen = 1 + w*3;
  const raw = Buffer.alloc(rowLen*h);
  for (let y=0;y<h;y++){
    raw[y*rowLen]=0;
    for (let x=0;x<w;x++){
      const o=y*rowLen+1+x*3;
      raw[o]=200; raw[o+1]=180; raw[o+2]=160;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
function makeWAV(seconds, sampleRate) {
  const num = seconds*sampleRate;
  const dataSize = num*2;
  const buf = Buffer.alloc(44+dataSize);
  buf.write('RIFF',0); buf.writeUInt32LE(36+dataSize,4); buf.write('WAVE',8);
  buf.write('fmt ',12); buf.writeUInt32LE(16,16); buf.writeUInt16LE(1,20);
  buf.writeUInt16LE(1,22); buf.writeUInt32LE(sampleRate,24);
  buf.writeUInt32LE(sampleRate*2,28); buf.writeUInt16LE(2,32); buf.writeUInt16LE(16,34);
  buf.write('data',36); buf.writeUInt32LE(dataSize,40);
  for (let i=0;i<num;i++){
    const t=i/sampleRate;
    const v=Math.round(Math.sin(2*Math.PI*330*t)*4000);
    buf.writeInt16LE(v, 44+i*2);
  }
  return buf;
}
fs.writeFileSync('tools/_test_img.png', makePNG(120,120));
fs.writeFileSync('tools/_test_audio.wav', makeWAV(1, 16000));
fs.writeFileSync('tools/_test_img.b64', makePNG(120,120).toString('base64'));
fs.writeFileSync('tools/_test_audio.b64', makeWAV(1,16000).toString('base64'));
console.log('img bytes', fs.statSync('tools/_test_img.png').size);
console.log('wav bytes', fs.statSync('tools/_test_audio.wav').size);
