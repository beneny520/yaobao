// 线上 yb-ai 三链路复现：chat(sanity) + vision(120x120) + asr(真WAV) + gate(__nope__)
const fs = require('fs');
const EP = 'https://idxzxnxfcpazdtaossna.supabase.co/functions/v1/yb-ai';
const KEY = 'sb_publishable_saKdquYW3UGOcXnYpgvhWA_-M6rOnw4';
const CODE = 'testfam001';

async function call(op, payload, code = CODE) {
  const r = await fetch(EP, {
    method: 'POST',
    headers: { 'apikey': KEY, 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, code, ...payload }),
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = txt; }
  console.log(`\n--- ${op} [code=${code}] (HTTP ${r.status}) ---`);
  console.log(typeof j === 'string' ? j.slice(0, 600) : JSON.stringify(j).slice(0, 900));
}

(async () => {
  const img = fs.readFileSync('tools/_test_img.b64', 'utf8').trim();
  const aud = fs.readFileSync('tools/_test_audio.b64', 'utf8').trim();
  console.log('img b64 len:', img.length, '| aud b64 len:', aud.length);
  await call('chat', { text: '我今天头有点晕', petName: '小宝', elderName: '奶奶' });
  await call('vision', { imageBase64: img });
  await call('asr', { audioBase64: aud, format: 'wav' });
  await call('chat', { text: 'x' }, '__nope__');
})();
