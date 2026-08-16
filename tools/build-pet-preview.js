/**
 * 从 clay-buddy.html 抽取 3D 建模工具箱，生成独立的六宠物预览页。
 * 不手工复制代码，避免预览页与主应用走样。
 *
 *   node tools/build-pet-preview.js
 *   然后浏览器打开 pets-preview.html
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'clay-buddy.html');
const OUT = path.join(ROOT, 'pets-preview.html');

const html = fs.readFileSync(SRC, 'utf8');
const m = html.match(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/);
if (!m) throw new Error('没找到 text/babel 脚本块');

const code = m[1];
const start = code.indexOf('const PET_SPECS');
const end = code.indexOf('};', code.indexOf('const PET_BUILDERS')) + 2;
if (start < 0 || end < 2) throw new Error('没定位到建模工具箱区段');
const toolkit = code.slice(start, end);

// 主应用 CSS 里的设计令牌，预览页沿用同一套底色
const bg = (html.match(/--clay-bg:\s*([#\w]+)/) || [, '#EEF1F6'])[1];

const NAMES = {
  bunny: '兔兔 · 糖包', bear: '小熊 · 奶酪熊', cat: '小猫 · 小甜橘',
  dog: '小狗 · 糯米', penguin: '企鹅 · 冰豆', fox: '狐狸 · 莓莓',
};

const out = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>药宝 · 六只黏土小动物预览</title>
<!-- 本文件由 tools/build-pet-preview.js 自动生成，请勿手工编辑 -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<style>
  body { margin:0; background:${bg}; font-family:'Fredoka','Noto Sans SC',sans-serif; color:#334155; }
  h1 { text-align:center; font-size:20px; padding:22px 16px 4px; margin:0; }
  .hint { text-align:center; font-size:13px; color:#94a3b8; margin:0 0 14px; }
  .bar { display:flex; gap:8px; justify-content:center; flex-wrap:wrap; margin-bottom:20px; }
  .bar button {
    border:0; padding:9px 18px; border-radius:16px; cursor:pointer; font-size:14px;
    font-family:inherit; font-weight:600; color:#64748b; background:#fff;
    box-shadow:0 4px 10px -3px rgba(148,163,184,.35), inset 0 -3px 5px rgba(0,0,0,.05);
  }
  .bar button.on {
    color:#fff; background:linear-gradient(135deg,#FCA18B 0%,#F79B83 100%);
    box-shadow:0 8px 20px -4px rgba(247,155,131,.5), inset 0 -6px 8px rgba(0,0,0,.15);
  }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:18px; padding:0 20px 44px; max-width:1180px; margin:0 auto; }
  .card { background:#fff; border-radius:28px; padding:10px; text-align:center;
          box-shadow:0 10px 24px -8px rgba(148,163,184,.45), inset 0 -6px 10px rgba(0,0,0,.04), inset 0 4px 8px rgba(255,255,255,.6); }
  .card canvas { display:block; border-radius:20px; cursor:grab; }
  .card canvas:active { cursor:grabbing; }
  .cap { font-size:14px; font-weight:700; padding:8px 0 4px; }
</style>
</head>
<body>
<h1>药宝 · 六只黏土小动物</h1>
<p class="hint">拖动可 360° 查看 · 点击可捏一捏 · 下方切换状态</p>
<div class="bar" id="bar"></div>
<div class="grid" id="grid"></div>

<script>
${toolkit}

const NAMES = ${JSON.stringify(NAMES, null, 2)};
const STATES = [
  ['idle','平静'], ['happy','开心'], ['eating','吃药'],
  ['sad','没精神'], ['sleeping','睡着了'],
];
const lerp = (a,b,t) => a + (b-a)*t;
let currentState = 'idle';

const bar = document.getElementById('bar');
STATES.forEach(([k,label]) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = k === 'idle' ? 'on' : '';
  b.onclick = () => {
    currentState = k;
    [...bar.children].forEach(c => c.className = '');
    b.className = 'on';
    if (k === 'eating') stages.forEach(s => { s.target = 0.55; setTimeout(()=>{ s.target = 1.15; setTimeout(()=>{ s.target = 1.0; },180); },150); });
  };
  bar.appendChild(b);
});

// 预览卡是正方形；verify-pets.js 会覆写 ASPECT 来核查竖长容器的取景
var ASPECT = globalThis.__forceAspect || 1;
const SIZE = 280;
const stages = [];
const grid = document.getElementById('grid');

Object.keys(PET_BUILDERS).forEach(id => {
  const spec = PET_SPECS[id];
  const card = document.createElement('div');
  card.className = 'card';
  const holder = document.createElement('div');
  card.appendChild(holder);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.textContent = NAMES[id];
  card.appendChild(cap);
  grid.appendChild(card);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, ASPECT, 0.1, 100);
  camera.position.set(0, 0, cameraZ(ASPECT));

  // 灯光与主应用完全一致
  scene.add(new THREE.AmbientLight(0xfff5f0, 0.7));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.8); d1.position.set(5, 8, 5); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xffdcd3, 0.4); d2.position.set(-5, -5, -2); scene.add(d2);

  const mats = {
    body: makeClayMat(spec.body),
    alt: makeClayMat(spec.alt),
    accent: new THREE.MeshStandardMaterial({ color: spec.accent, roughness: 0.9, metalness: 0.0 }),
    eye: new THREE.MeshStandardMaterial({ color: 0x111116, roughness: 0.1, metalness: 0.9 }),
    cheek: new THREE.MeshStandardMaterial({ color: 0xfca18b, roughness: 0.95, transparent: true, opacity: 0.8 }),
  };
  const model = PET_BUILDERS[id](mats);
  model.headTilt = 0;
  model.group.scale.setScalar(spec.fit || 0.92);

  const stage = new THREE.Group();
  stage.position.y = -0.2;
  stage.add(model.group);
  scene.add(stage);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(SIZE, Math.round(SIZE / ASPECT));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  holder.appendChild(renderer.domElement);

  const st = { scene, camera, renderer, stage, model, cur: 1, vel: 0, target: 1, angY: 0, angX: 0 };
  stages.push(st);

  // 拖动旋转 + 点击挤压，与主应用同一套手感
  let drag = null;
  const el = renderer.domElement;
  el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); drag = { x:e.clientX, y:e.clientY, aY:st.angY, aX:st.angX, moved:false }; });
  el.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX-drag.x, dy = e.clientY-drag.y;
    if (Math.abs(dx)+Math.abs(dy) > 6) drag.moved = true;
    st.angY = drag.aY + dx*0.012;
    st.angX = Math.max(-0.55, Math.min(0.55, drag.aX + dy*0.008));
  });
  el.addEventListener('pointerup', () => {
    if (drag && !drag.moved) { st.target = 0.65; setTimeout(()=>{ st.target = 1.0; },120); }
    drag = null;
  });
});

const clock = new THREE.Clock();
(function animate(){
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  const st0 = currentState;

  let amplitude=0.08, speed=2.0, headTilt=0, eyeOpen=1, limbAmp=0.12, limbSpeed=2.4;
  if (st0==='sad')          { amplitude=0.03; speed=0.8; headTilt=-0.16; eyeOpen=0.62; limbAmp=0.04; limbSpeed=1.0; }
  else if (st0==='sleeping'){ amplitude=0.02; speed=0.5; headTilt=-0.10; eyeOpen=0.06; limbAmp=0.02; limbSpeed=0.6; }
  else if (st0==='happy')   { amplitude=0.16; speed=4.2; headTilt=0.06;  eyeOpen=0.30; limbAmp=0.30; limbSpeed=5.0; }
  else if (st0==='eating')  { amplitude=0.10; speed=3.2;                 eyeOpen=0.45; limbAmp=0.22; limbSpeed=4.0; }

  for (const s of stages) {
    const force = s.target - s.cur;
    s.vel += force*0.22; s.vel *= 0.76; s.cur += s.vel;
    s.stage.scale.y = s.cur;
    s.stage.scale.x = 2.0 - s.cur;
    s.stage.scale.z = 2.0 - s.cur;
    s.stage.position.y = -0.2 + Math.sin(t*speed)*amplitude;
    s.stage.rotation.y = s.angY + Math.sin(t*0.7)*0.04;
    s.stage.rotation.x = s.angX;
    s.stage.rotation.z = Math.cos(t*0.5)*0.03;

    const m = s.model;
    m.headTilt = lerp(m.headTilt, headTilt, 0.08);
    m.head.rotation.x = m.headTilt + (st0==='eating' ? Math.sin(t*16)*0.05 : 0);
    m.eyes.forEach(e => { e.scale.y = lerp(e.scale.y, eyeOpen, 0.12); });
    m.ears.forEach((p,i) => {
      const droop = (st0==='sad'||st0==='sleeping') ? 0.55 : 0;
      p.userData.cur = lerp(p.userData.cur, p.userData.base.rx + droop, 0.08);
      p.rotation.x = p.userData.cur + Math.sin(t*limbSpeed + i*1.7)*limbAmp*0.5;
    });
    m.arms.forEach((p,i) => { p.rotation.x = Math.sin(t*limbSpeed + i*Math.PI)*limbAmp*0.6; });
    m.wings.forEach((p,i) => { p.rotation.z = p.userData.base.rz + Math.sin(t*limbSpeed + i*Math.PI)*limbAmp*0.9; });
    if (m.tail) m.tail.rotation.z = m.tail.userData.base.rz + Math.sin(t*(limbSpeed+1.6))*limbAmp*1.3;

    s.renderer.render(s.scene, s.camera);
  }
})();
</script>
</body>
</html>
`;

fs.writeFileSync(OUT, out, 'utf8');
console.log('已生成 ' + path.relative(ROOT, OUT) + '（建模代码抽取自 clay-buddy.html，共 ' + toolkit.split('\n').length + ' 行）');
