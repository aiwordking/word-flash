# 云同步（可选）

默认不启用。App 仍然是本地优先：不配置 Supabase 时，所有数据只存在浏览器的 `localStorage`，和之前完全一样。

启用后可以做到：

- 用户名 + 邮箱注册 / 登录（用户名可留空，默认取邮箱前缀）
- 把本机进度上传到云端
- 在新设备或新域名上恢复进度
- 进度变化后自动上传（可开关）
- 云端比本机新时不会自动覆盖，避免误丢数据

云同步使用 [Supabase](https://supabase.com) 免费项目：Postgres 数据库 + 邮箱认证。数据存在你自己的 Supabase 项目里，由 Supabase 托管；本应用没有自己的后端。

## 1. 创建 Supabase 项目

1. 打开 <https://supabase.com>，注册并创建一个免费项目。
2. 项目创建完成后，进入 **SQL Editor**。
3. 把本仓库的 `supabase/schema.sql` 整段粘贴进去，执行一次。
4. 进入 **Project Settings → API**，记下：
   - Project URL，例如 `https://abcdefgh.supabase.co`https://dftimmfomyljrvjqtrnc.supabase.co
   - `anon` `public` key
   - sb_publishable_KHyvc2aqsMrJbkiYoJcgNw_QCWxjstu

> 只使用 `anon public` key。绝对不要把 `service_role` key 放进前端或 `cloud-config.js`。

## 2. 配置 App

有两种方式，任选一种。

### 方式 A：在 App 内填写（推荐给个人使用）

1. 打开 App → 右上角设置 → 云同步 → 设置。
2. 填入 Project URL 和 anon public key。
3. 保存后即可注册 / 登录。

配置保存在本机 `localStorage`，不会上传到别处。

### 方式 B：写进部署文件（推荐给多人使用）

编辑 `assets/cloud-config.js`：

```js
window.FLASHVOCAB_CLOUD = {
  url: "https://abcdefgh.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIs...",
};
```

这样所有访问这个站点的人都会连到同一个 Supabase 项目，各自用邮箱注册，数据互相隔离（RLS 保证只能读写自己的行）。anon key 本来就是公开的，可以放在前端。

改完 `cloud-config.js` 后建议强制刷新一次（Ctrl+F5）；部分静态托管会缓存旧 JS，导致页面仍显示“未配置”。

### 多端登录：账号一份，配置要不要重复填

- 账号只有一份。手机、电脑、平板都用同一个邮箱密码登录，看到的是同一份云端进度，不需要每台设备注册。
- 登录状态按浏览器保存，所以每台设备第一次打开都要登录一次；之后会自动续期，除非手动退出或清理浏览器数据。
- 需要重复填的只有 `Project URL` 和 `anon public key`，因为那是“连到哪个数据库”，不是账号。用上面的方式 A，每个浏览器都得填一遍；用方式 B 把它们写进 `cloud-config.js` 并重新部署，所有设备打开就只差登录一步。

## 3. 配置 Supabase 认证

在 Supabase Dashboard：

1. **Authentication → Providers → Email**：确保 Email 已启用。
2. **Authentication → URL Configuration**：
   - Site URL 填你的线上地址，例如 `https://your-app.vercel.app`
   - Redirect URLs 加入：
     - `http://localhost:5173`
     - `https://your-app.vercel.app`
3. 如果只是自己用，可以在 **Authentication → Providers → Email** 里关闭 **Confirm email**，注册后直接登录，少一步。
4. 保留邮箱确认也可以：注册后点邮件里的链接，再回 App 用邮箱密码登录。
5. 如果是公开部署、不希望陌生人注册：先用自己的邮箱注册，然后在 **Authentication → Providers → Email** 关闭 **Allow new users to sign up**。

## 4. 使用

1. 设置 → 云同步 → 填写用户名（可选）、邮箱和密码，注册或登录。
   未登录时顶栏会有一个「登录」按钮，点它就是打开这个面板；登录后这里会变成用户名头像。
2. 填好 Project URL 和 key 后可以先点「测试连接」，它会告诉你这个项目是否允许注册、注册后是否需要邮箱确认，省得靠猜。
3. 登录报错时看到的是中文提示，比如「邮箱或密码不匹配」「邮箱还没确认」「这个邮箱已经注册过了」；忘记密码点「重置密码」。
4. 首次使用点 **上传本机**，把当前进度写到云端。
   登录成功后会自动判断：本机是空的、云端有备份 → 直接恢复到本机；本机已有进度 → 自动打开「自动上传」。
5. 换设备后登录，点 **从云端恢复**。
6. 打开 **自动上传** 后，学习进度变化会在约 1.4 秒后同步到云端。

## 冲突策略

当前是“显式选择”而不是自动合并：

- 上传前会检查云端时间。云端比本机新时，不会自动覆盖，会弹窗让你确认。
- 自动上传遇到云端更新时，会暂停并提示，不会静默覆盖。
- 恢复云端会覆盖本机当前进度，操作前有确认弹窗。

这样牺牲了一点全自动体验，但不会在两边都有新进度时悄悄丢数据。后续如果要做逐词合并，可以在 `progress` 上按 `last` 时间做字段级合并。

## 数据表

`supabase/schema.sql` 会创建：

```text
public.flashvocab_state
  user_id uuid primary key -> auth.users(id)
  state jsonb            -- 整个 App 状态（进度、天数、设置、自定义词库）
  client_updated_at bigint -- 客户端最后修改时间（毫秒）
  updated_at timestamptz   -- 服务端最后写入时间
```

RLS 策略保证：

- 登录用户只能 `select / insert / update / delete` 自己的 `user_id` 行。
- `anon` 角色没有任何权限。

## 免费额度

Supabase 免费计划大致包含：

- 500MB 数据库
- 1GB 文件存储
- 50,000 月活用户
- 2 个活跃项目

这个 App 的状态只有几十 KB，正常使用远远用不完。具体额度以 <https://supabase.com/pricing> 当前页面为准。

## 常见问题

**登录提示网络请求失败**

- 检查 Project URL 是否以 `https://` 开头、是否多了结尾斜杠。
- 检查 anon key 是否复制完整。
- 检查 Supabase 项目是否被暂停（免费项目长期不活跃会暂停）。

**注册后没有登录**

- Supabase 默认开启邮箱确认。去邮箱点确认链接，再回 App 登录；或在 Supabase 关闭 Confirm email。

**上传/恢复报 401 或 403**

- 登录过期，退出后重新登录。
- 没有执行 `supabase/schema.sql`，或 RLS 策略没建好。
- 用了 `service_role` key 而不是 `anon public` key。

**换域名后进度没了**

- 本地 `localStorage` 按域名隔离。旧域名先导出备份，或登录云同步后从云端恢复。

**file:// 直接打开能用云同步吗**

- 登录和同步通常可以，但邮箱确认链接需要 http/https 地址。正式使用建议部署到 Vercel / Netlify / Cloudflare Pages。
