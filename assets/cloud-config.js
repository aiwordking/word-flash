/* ============================================================
   闪词 FlashVocab — 可选云同步配置
   ------------------------------------------------------------
   不填也能正常使用，数据只保存在本机浏览器。

   想让手机、电脑、平板都共用一份进度，把这里填上：
   1. 在 https://supabase.com 创建免费项目
   2. 在 SQL Editor 执行 supabase/schema.sql（建表 + 行级权限）
   3. Project Settings → API 复制 Project URL 和 anon public key 填到下面
   4. 重新部署一次

   填好之后，任何设备打开这个站点都已经连到同一个项目，
   用户只需要用同一个邮箱密码登录，不用再逐台填 URL 和 key。

   安全：这里只能填 anon public / Publishable key。
   它们本来就是公开的，真正的权限由数据库的 RLS 控制，
   每个账号只能读写自己的那一行。绝对不要填 service_role / Secret key，
   那等于把整库的钥匙发到浏览器里。
   ============================================================ */
window.FLASHVOCAB_CLOUD = {
  url: "",       // 例如 https://abcdefgh.supabase.co
  anonKey: "",   // 例如 eyJhbGciOi... 或 sb_publishable_...
};
