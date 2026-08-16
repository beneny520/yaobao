/**
 * 无浏览器验证 3D 宠物系统。
 * 用真实 Three.js 执行 clay-buddy.html 里的建模代码 + pets-preview.html 的动画循环，
 * 检查三件事：
 *   1. 六种动物都能建出来，各有物种部件
 *   2. 三种容器宽高比 × 五种状态，扫完整个动画周期都不出画
 *      （竖直看挤压到 1.15 的最高点，水平看压扁到 0.55 时 x 被放大到 1.45 倍的最宽点）
 *   3. 每种动物的标志性部位在正面轮廓里露得出来，不被躯干挡住
 *
 *   cd tools && npm install      # 只需一次
 *   node verify-pets.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const THREE = require('three');

const ROOT = path.resolve(__dirname, '..');
const previewPath = path.join(ROOT, 'pets-preview.html');
if (!fs.existsSync(previewPath)) {
  console.error('缺少 pets-preview.html，先跑：node tools/build-pet-preview.js');
  process.exit(1);
}
const rawBody = fs.readFileSync(previewPath, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]
  // vm 里顶层 const/let 不会挂到 globalThis，追加一段闭包把需要的句柄递出来。
  // setTime 劫持 clock，好让验证脚本能扫过整个动画周期而不是只看一瞬间。
  + '\n;globalThis.__api = { stages, PET_SPECS, PET_BUILDERS, cameraZ, ASPECT,'
  + ' setState: (s) => { currentState = s; },'
  + ' setTime: (v) => { clock.getElapsedTime = () => v; } };\n';

const mkEl = (tag) => ({
  tagName: tag, style: {}, children: [], className: '', textContent: '',
  appendChild(c) { this.children.push(c); return c; },
  addEventListener() {}, setPointerCapture() {},
});
class FakeRenderer {
  constructor() { this.domElement = mkEl('canvas'); }
  setSize() {} setPixelRatio() {} render() {}
}
const THREEStub = new Proxy(THREE, {
  get: (t, k) => (k === 'WebGLRenderer' ? FakeRenderer : t[k]),
});

/** 按指定容器宽高比起一份独立的场景 */
function boot(aspect) {
  const nodes = { bar: mkEl('div'), grid: mkEl('div') };
  // animate 是自调度的：每帧开头把自己重新注册进来。这里只存住回调，由 step() 手动驱动。
  let pendingFrame = null;
  const ctx = {
    THREE: THREEStub,
    document: { createElement: mkEl, getElementById: (id) => nodes[id] },
    window: { devicePixelRatio: 2 },
    console: { log() {} },
    setTimeout: () => {},
    requestAnimationFrame: (fn) => { pendingFrame = fn; },
    __forceAspect: aspect,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(rawBody, ctx, { filename: 'pets-preview.js' });

  const api = ctx.__api;
  api.step = (t, squash) => {
    api.setTime(t);
    api.stages.forEach((s) => { s.cur = squash; s.vel = 0; s.target = squash; });
    const fn = pendingFrame;
    if (!fn) throw new Error('动画循环没有注册 requestAnimationFrame 回调');
    pendingFrame = null;
    fn();
  };
  api.halfH = Math.tan((40 * Math.PI / 180) / 2) * api.cameraZ(aspect);
  api.halfW = api.halfH * aspect;
  return api;
}

const NAMES = { bunny: '兔兔', bear: '小熊', cat: '小猫', dog: '小狗', penguin: '企鹅', fox: '狐狸' };
const STATES = ['idle', 'happy', 'eating', 'sad', 'sleeping'];
const STEPS = 96, SPAN = 12.6;   // 覆盖最慢的 speed=0.5 一个完整正弦周期

let fail = 0;
const ok = (c) => (c ? '' : ((fail++), ' ✗'));
let tightest = { margin: Infinity, who: '' };   // 记录离出画最近的一次，便于后续改模型时盯住

// ---------------------------------------------------------------- 1. 建模
const base = boot(1);
const ids = Object.keys(base.PET_BUILDERS);
console.log('== 1. 建模 ==');
ids.forEach((id, i) => {
  const m = base.stages[i].model;
  let meshes = 0;
  m.group.traverse((o) => { if (o.isMesh) meshes++; });
  console.log(
    `  ${NAMES[id]}  网格${String(meshes).padStart(2)}  ` +
    `耳/角${m.ears.length} 臂${m.arms.length} 翅${m.wings.length} 眼${m.eyes.length} ` +
    `尾${m.tail ? '有' : '无'}  fit${base.PET_SPECS[id].fit}` +
    ok(meshes >= 10 && m.eyes.length === 2)
  );
});

// ---------------------------------------------------------------- 2. 取景
// 两个挂载点：手机固定 260px 高的舞台（偏横），桌面 flex-grow 的舞台（可能竖长）
const CASES = [
  { aspect: 1.32, note: '手机舞台 343×260' },
  { aspect: 1.00, note: '正方' },
  { aspect: 0.70, note: '桌面竖长容器' },
];
console.log('\n== 2. 取景：三种容器宽高比 × 五种状态，扫完整个动画周期 ==');
for (const c of CASES) {
  const api = boot(c.aspect);
  const { stages, step, halfH, halfW } = api;
  console.log(`\n  ── aspect ${c.aspect}（${c.note}）  相机 z=${api.cameraZ(c.aspect).toFixed(2)}  ` +
    `可视 ±${halfW.toFixed(2)} × ±${halfH.toFixed(2)}`);

  for (const st of STATES) {
    api.setState(st);
    for (let f = 0; f < 150; f++) step(f * 0.016, 1.15);   // 让 lerp（眼睛、耳朵、低头）先收敛

    const hull = stages.map(() => ({ top: -Infinity, bot: Infinity, wide: 0 }));
    // 竖直最坏帧：挤压 1.15（拉高）；水平最坏帧：压扁 0.55（x 放大到 1.45）
    for (const squash of [1.15, 0.55]) {
      for (let f = 0; f <= STEPS; f++) {
        step((f / STEPS) * SPAN, squash);
        stages.forEach((s, i) => {
          s.stage.updateMatrixWorld(true);
          const b = new THREE.Box3().setFromObject(s.stage);
          hull[i].top = Math.max(hull[i].top, b.max.y);
          hull[i].bot = Math.min(hull[i].bot, b.min.y);
          hull[i].wide = Math.max(hull[i].wide, Math.abs(b.min.x), Math.abs(b.max.x));
        });
      }
    }
    const cells = hull.map((h, i) => {
      const m = Math.min(halfH - h.top, halfH + h.bot, halfW - h.wide);
      if (m < tightest.margin) tightest = { margin: m, who: `${NAMES[ids[i]]} ${st} @aspect${c.aspect}` };
      const inside = m >= -0.02;
      return `${NAMES[ids[i]]}y[${h.bot.toFixed(2)},${h.top.toFixed(2)}]x±${h.wide.toFixed(2)}${ok(inside)}`;
    });
    console.log(`     ${st.padEnd(9)} ${cells.join(' ')}`);
  }
}

// ---------------------------------------------------------------- 3. 辨识度
console.log('\n== 3. 物种识别特征（正面可见轮廓）==');
base.setState('idle');
base.stages.forEach((s) => { s.angY = 0; s.angX = 0; });
for (let f = 0; f < 150; f++) base.step(f * 0.016, 1);
base.step(0, 1);

const feat = {
  bunny: ['长耳朵', (m) => m.ears, 'y'],
  bear: ['圆耳朵', (m) => m.ears, 'x'],
  cat: ['尾巴', (m) => [m.tail], 'x'],
  dog: ['垂耳', (m) => m.ears, 'x'],
  penguin: ['翅膀', (m) => m.wings, 'x'],
  fox: ['蓬松尾巴', (m) => [m.tail], 'x'],
};
ids.forEach((id, i) => {
  const m = base.stages[i].model;
  m.group.updateMatrixWorld(true);
  const whole = new THREE.Box3().setFromObject(m.group);
  const [label, pick, axis] = feat[id];
  const pb = new THREE.Box3();
  pick(m).filter(Boolean).forEach((p) => pb.union(new THREE.Box3().setFromObject(p)));
  const reach = axis === 'y' ? pb.max.y : Math.max(Math.abs(pb.min.x), Math.abs(pb.max.x));
  const limit = axis === 'y' ? whole.max.y : Math.max(Math.abs(whole.min.x), Math.abs(whole.max.x));
  // 特征应当触及整体轮廓的边缘；低于 55% 说明基本被躯干挡住，认不出是什么动物
  const ratio = reach / limit;
  console.log(`  ${NAMES[id]}  ${label} 触达轮廓 ${(ratio * 100).toFixed(0)}%` + ok(ratio > 0.55));
});

console.log(`\n最小出画余量 ${tightest.margin.toFixed(3)}（${tightest.who}）` +
  (tightest.margin < 0.03 ? '  ⚠ 余量偏小，再加大模型就要顶出画面了' : ''));
console.log(fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项未通过`);
process.exit(fail === 0 ? 0 : 1);
