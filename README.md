# 药宝 PillPal / Clay Buddy

单文件 React + Three.js 老年用药提醒 Web 应用，带 3D 黏土宠物陪伴。

线上体验：**https://yaobao.pages.dev**

## 快速开始
1. 用浏览器打开 `clay-buddy.html` 即可运行
2. 管理端创建家庭，老人端用家庭码登录

## 核心功能
- **F2 服药提醒引擎**：定时推送、漏服升级、成长积分
- **F3 3D 黏土宠物**：6 种动物、4 种情绪、随服药行为升级
- **F6 亲情留言**：家人端留言、老人端收到气泡提醒
- **F11 AI 能力体系**：语音陪伴、拍照识别加药、医嘱语音速记、健康关心卡

## 技术栈
- 前端：React 19.2 + Three.js r128（通过 CDN 单文件，无打包步骤）
- 后端：Supabase（Postgres + PostgREST RPC + Realtime Broadcast）
- AI：阿里云百炼 DashScope（通过 Supabase Edge Function 代理，Key 只在服务端）

## 环境验证（首次使用必做）

AI 功能和 3D 渲染依赖真机环境，**使用前必须验证**：

### 微信内验证步骤
1. 在微信中打开 `verify.html`（或用微信扫描此页面二维码）
2. 点击「一键测试全部」
3. 检查 4 个验证项是否全部通过：
   - 🎤 **麦克风权限**：语音陪伴功能必需
   - 🎨 **WebGL 渲染**：3D 宠物流畅显示
   - 🗄️ **Supabase 连通**：后端数据读写
   - 🔑 **百炼 Key 配置**：AI 对话/识别/语音转文字

### 补救措施
- **麦克风失败**：微信 → 我 → 设置 → 隐私 → 允许访问麦克风
- **WebGL 失败**：检查微信版本、尝试系统浏览器打开
- **Supabase 失败**：检查网络、确认项目 ref 未被封禁
- **百炼 Key 失败**：去 Supabase Dashboard 设置 `DASHSCOPE_API_KEY`（见下方）

### 百炼 Key 设置（必须人手做）
1. 登录 [Supabase Dashboard](https://supabase.com/dashboard)
2. 选择项目 `idxzxnxfcpazdtaossna`
3. 左侧 Edge Functions → Secrets → New secret
4. Name: `DASHSCOPE_API_KEY`，Value: 你的阿里云百炼 API Key
5. 保存后重新运行 `verify.html` 验证

> **为什么必须这样**：Key 放前端会被抓包盗刷，Token 补贴会被刷光。MCP 无法设 secret，只能人手操作。

## 项目结构
```
yaobao/
├── clay-buddy.html      # 主应用（单文件 2991 行）
├── verify.html          # 环境验证页面
├── README.md            # 本文件
├── tools/
│   ├── package.json     # npm run verify 脚本
│   ├── check-syntax.js  # JSX 语法检查
│   ├── build-pet-preview.js  # 宠物预览生成
│   └── verify-pets.js   # 宠物特征验证
└── supabase/
    ├── README.md        # 后端技术说明
    └── migrations/
        └── 0001_yaobao_schema.sql  # 数据库迁移（可重建完整后端）
```

## 常用命令
```bash
cd tools
npm install    # 首次运行
npm run verify # 验证语法 + 宠物特征
```

## 许可
MIT
