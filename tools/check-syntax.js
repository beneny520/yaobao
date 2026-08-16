/**
 * clay-buddy.html 是浏览器内用 @babel/standalone 现场编译 JSX 的单文件应用，
 * 语法错误只有打开页面才会暴露。这里在命令行先编一遍，改完立刻能知道有没有写坏。
 *
 *   cd tools && node check-syntax.js
 */
const fs = require('fs');
const path = require('path');
const Babel = require('@babel/standalone');

const SRC = path.resolve(__dirname, '..', 'clay-buddy.html');
const html = fs.readFileSync(SRC, 'utf8');
const m = html.match(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/);
if (!m) { console.error('没找到 text/babel 脚本块'); process.exit(1); }

const code = m[1];
const lines = code.split('\n').length;
try {
  Babel.transform(code, { presets: ['react'], filename: 'clay-buddy.jsx' });
  console.log(`✅ JSX 语法通过（${lines} 行）`);
} catch (e) {
  console.error(`❌ JSX 语法错误：${e.message}`);
  process.exit(1);
}
