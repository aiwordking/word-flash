# 闪词 FlashVocab

参照「闪电背单词」的卡片速记思路做的背单词 Web App：**选词库 → 立刻开背**。
纯前端、零构建，默认无需登录，双击 `index.html` 就能用；也可以把整个文件夹丢到任意静态托管上，几十秒完成部署。需要跨设备同步时，可选接入自己的 Supabase 项目。

## 功能

- **1 个内置词库**：中考课标 1600 词，按《义务教育英语课程标准（2022 年版）》三级词汇表整理，1592 个去重词条。
- **卡片速记**：英 → 中、中 → 英、拼写三种模式，支持点击翻面、左右滑动评分、空格/数字键操作。
- **间隔复习**：Leitner 六级间隔（10 分钟 → 1 天 → 2 天 → 4 天 → 7 天 → 15 天 → 30 天），到期词自动混入今日队列。
- **每日目标**：默认 20 个新词，可在设置中调整；达标后只复习、不再加新词。
- **发音**：调用浏览器语音合成，支持美音/英音，可关闭自动朗读。
- **四选一测验**：按词库随机抽题，答错自动进入错题清单，可一键重做错题。
- **学习数据**：连续天数、今日学习、掌握率、正确率、最近 10 周热力图、记忆构成、各词库进度。
- **移动端一屏**：首页按 360–390 宽、550–850 高的可视区压缩排版，打开即可看到任务卡和进度，不用下拉。
- **本地存储 + 备份**：进度保存在 `localStorage`，设置里可导出/导入 JSON 备份。
- **可选云同步**：接入自己的 Supabase 免费项目，支持用户名 + 邮箱登录、上传/恢复、自动同步；登录后顶部会显示用户名。不配置时完全不影响本地使用，详见 [CLOUD.md](CLOUD.md)。
- **深浅主题 / 响应式**：手机底部标签栏，桌面顶部导航。

## 立即运行

### 方式一：直接打开（最简单）

双击 `index.html`。所有词库都是本地 JS 文件，不依赖网络请求，`file://` 下也能正常学习。
注意：`file://` 下不同路径的 `index.html` 会被浏览器视为不同来源，进度不互通。

### 方式二：本地服务器（推荐）

```bash
cd word-flash
python -m http.server 5173
```

打开 <http://localhost:5173>。Windows 也可以双击 `start-server.bat`。

## 部署

整个 `word-flash/` 就是成品，没有构建步骤。完整步骤见 [DEPLOY.md](DEPLOY.md)，常用方案：

- **Netlify Drop**：打开 <https://app.netlify.com/drop>，把文件夹拖进去，立刻得到公网地址。
- **Vercel**：`npx vercel --prod`，框架选 Other，输出目录保持默认。
- **Cloudflare Pages**：`npx wrangler pages deploy . --project-name flashvocab`。
- **GitHub Pages**：把文件夹内容推到仓库，Settings → Pages → 选择分支根目录。
- **Docker / Nginx**：`docker build -t flashvocab . && docker run -d -p 8080:80 flashvocab`。
- **对象存储**：上传到阿里云 OSS / 腾讯云 COS，开启静态网站托管。
- **内网分发**：压缩整个文件夹发给同事，解压后双击 `index.html`。

> 学习进度按浏览器 + 域名隔离。换域名/换设备前，先在「设置 → 数据备份」导出 JSON，在新环境导入。

## 词库

| 词库 | 标识 | 词数 |
| --- | --- | --- |
| 中考课标 1600 词 | `zhongkao` | 1592 |

词表按课标三级词汇整理，合并了 `a (an)`、`grandfather (grandpa)` 等重复词形，所以是 1592 个去重词条；音标和例句来自开源词库，已过滤明显超纲或不适宜的例句。

词表和例句仅用于个人学习；如需商用或再分发，请自行核对原始课标文本与开源词库的许可。

### 新增内置词库

1. 复制 `data/books/zhongkao.js`，改 `id / name / tag / color / desc / words`。
2. 在 `index.html` 的 `app.js` 之前加一行 `<script src="data/books/你的文件.js"></script>`。
3. 刷新页面，新词库会出现在首页。

## 学习机制

- 每个词按「掌握程度」分为 0–6 级，对应下次复习间隔：10 分钟、1 天、2 天、4 天、7 天、15 天、30 天。
- 点「认识」升级，「模糊」保持等级并在 12 小时后复习，「不认识」回到 0 级并在 5 分钟后复习；本组内还会再出现一次。
- 等级 ≥ 4 记为「已掌握」。
- 每日新词额度按「当天首次学习的词」计数，跨词库共享。

### 快捷键

- `空格`：显示释义
- `1 / 2 / 3`：不认识 / 模糊 / 认识
- 测验中 `1–4`：选择选项
- 拼写模式：输入后按 `Enter` 检查

## 目录结构

```text
word-flash/
├── index.html
├── start-server.bat
├── README.md
├── DEPLOY.md
├── CLOUD.md
├── Dockerfile
├── nginx.conf
├── assets/
│   ├── app.js            # 全部交互逻辑
│   ├── cloud.js          # 可选云同步（Supabase）
│   ├── cloud-config.js   # Supabase URL / anon key 配置
│   └── styles.css        # 主题与响应式布局
├── supabase/
│   └── schema.sql        # 云同步表结构与 RLS
└── data/
    └── books/          # 每个词库一个 JS 文件
        └── zhongkao.js
```

## 自定义

- 主题色：修改 `assets/styles.css` 顶部的 `--accent`、`--accent-text`。
- 默认每日目标：修改 `assets/app.js` 里的 `DEFAULT_SETTINGS.dailyNew`。
- 复习间隔：修改 `INTERVALS` 数组。
- 应用名称：修改 `index.html` 的 `<title>` 与顶栏品牌文案。

## 说明

- 语音朗读依赖系统语音包；没有对应口音时会自动回退到任意英语语音。浏览器不支持 `speechSynthesis` 时按钮无效但学习不受影响。
- 数据只存在本机浏览器，清理站点数据会丢失进度，重要数据请导出备份。
- 无后端、无统计上报、无第三方请求。
