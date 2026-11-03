/* ============================================================
   闪词 FlashVocab — 可选云同步（Supabase Auth + PostgREST）
   本地优先：不配置、不登录时完全不影响原有 localStorage 使用。
   ============================================================ */
(() => {
  "use strict";

  const CFG_KEY = "flashvocab.cloud.config";
  const SESSION_KEY = "flashvocab.cloud.session";
  let App = null;
  let cfg = null;
  let session = null;
  let pushTimer = null;
  let busy = false;
  let keyWarning = "";

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  const now = () => Date.now();
  const fmtTime = (ts) => {
    const n = Number(ts) || 0;
    if (!n) return "—";
    return new Date(n).toLocaleString("zh-CN", { hour12: false });
  };
  const hostOf = (url) => {
    try { return new URL(url).host; } catch (_) { return url; }
  };

  /* 只接受可以公开给浏览器的 key；service_role / secret 会绕过 RLS，直接拒绝 */
  function assertClientKey(key) {
    const k = String(key || "").trim();
    if (/^sb_secret/i.test(k)) {
      throw new Error("这是 Secret key，会在浏览器里泄露全部数据。请改用 Publishable key / anon public key。");
    }
    const parts = k.split(".");
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        if (String(payload.role || "").toLowerCase() === "service_role") {
          throw new Error("这是 service_role key，权限过高，不能放在前端。请改用 anon public key。");
        }
      } catch (err) {
        if (/service_role|Secret key/.test(err.message)) throw err;
      }
    }
    return k;
  }

  function readConfig() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); } catch (_) {}
    const file = window.FLASHVOCAB_CLOUD || {};
    const fileUrl = String(file.url || "").trim().replace(/\/+$/, "");
    let fileKey = "";
    keyWarning = "";
    try {
      fileKey = assertClientKey(file.anonKey);
    } catch (err) {
      fileKey = "";
      if (fileUrl && String(file.anonKey || "").trim()) keyWarning = err.message;
    }
    const useFile = !!(fileUrl && fileKey);
    const url = String(useFile ? fileUrl : saved.url || fileUrl || "").trim().replace(/\/+$/, "");
    const anonKey = String(useFile ? fileKey : saved.anonKey || fileKey || "").trim();
    if (!url || !anonKey) return null;
    return { url, anonKey, fromFile: useFile };
  }

  function readSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || !s.access_token || !s.refresh_token || !s.user || !s.user.id) return null;
      return s;
    } catch (_) {
      return null;
    }
  }

  function persistSession(s) {
    session = s;
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (_) {}
  }

  function clearSession() {
    session = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
  }

  async function request(path, { method = "GET", body, token, prefer } = {}) {
    if (!cfg) throw new Error("云同步未配置");
    const headers = { apikey: cfg.anonKey, "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (prefer) headers.Prefer = prefer;
    let res;
    try {
      res = await fetch(cfg.url + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new Error("网络请求失败，请检查 Supabase URL、网络或 CORS 配置");
    }
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
    if (!res.ok) {
      const msg = data.error_description || data.msg || data.message || data.hint || `请求失败（${res.status}）`;
      const error = new Error(msg);
      error.status = res.status;
      throw error;
    }
    return data;
  }

  function authRequest(path, body) {
    return request(path, { method: "POST", body });
  }

  /* 把 Supabase 的英文错误翻译成能直接照做的提示 */
  function describeError(err) {
    const raw = String((err && err.message) || err || "").trim();
    const m = raw.toLowerCase();
    if (m.includes("invalid login credentials")) {
      return "登录失败：邮箱或密码不匹配。这个邮箱如果从未在本项目注册过，Supabase 返回的也是同一句错误，所以先点「注册」试一次。";
    }
    if (m.includes("email not confirmed")) {
      return "邮箱还没确认：去收件箱点 Supabase 发来的确认链接，再回来登录。";
    }
    if (m.includes("user already registered") || m.includes("already been registered")) {
      return "这个邮箱已经注册过了，直接点「登录」；忘记密码点「重置密码」。";
    }
    if (m.includes("signups not allowed") || m.includes("signup is disabled")) {
      return "这个 Supabase 项目关闭了注册，请在 Authentication → Providers → Email 打开 Allow new users to sign up。";
    }
    if (m.includes("password should be at least") || m.includes("password is too short")) {
      return "密码太短，Supabase 默认要求至少 6 位。";
    }
    if (m.includes("unable to validate email") || m.includes("invalid format")) {
      return "邮箱格式不对，检查一下有没有多余空格或拼错。";
    }
    if (m.includes("for security purposes") || m.includes("rate limit") || m.includes("too many requests")) {
      return "请求太频繁被限流了，等 1 分钟再试。";
    }
    if (m.includes("failed to fetch") || m.includes("network")) {
      return "连不上 Supabase：检查 Project URL 是否抄错、网络是否可用。";
    }
    return raw || "操作失败，请稍后重试";
  }

  async function sendRecovery(email) {
    const redirect = encodeURIComponent(location.origin + location.pathname);
    await authRequest(`/auth/v1/recover?redirect_to=${redirect}`, { email });
  }

  /* 读项目公开设置，用来判断「注册了却登不上」到底卡在哪 */
  async function probeProject() {
    const s = await request("/auth/v1/settings");
    const emailOn = !!(s.external && (s.external.email === true || s.external.email === "true"));
    const parts = ["连接正常"];
    parts.push(emailOn ? "邮箱登录已开启" : "邮箱登录未开启（Authentication → Providers → Email 需要打开）");
    parts.push(s.disable_signup ? "注册已关闭（新账号注册会失败）" : "允许注册");
    parts.push(s.mailer_autoconfirm ? "注册后直接登录（不需要邮箱确认）" : "注册后需要点邮件确认链接");
    return parts.join(" · ");
  }

  async function signUp(email, password, username) {
    const name = String(username || email.split("@")[0] || "").trim();
    const payload = { email, password };
    if (name) payload.data = { username: name };
    const data = await authRequest("/auth/v1/signup", payload);
    const s = data.session || data;
    const user = s.user || data.user || (data.id ? data : null);
    if (s.access_token && s.refresh_token && user) {
      persistSession({ ...s, user });
      return { session: true };
    }
    return { session: false };
  }

  async function signIn(email, password) {
    const data = await authRequest("/auth/v1/token?grant_type=password", { email, password });
    const s = data.session || data;
    if (!s.access_token || !s.refresh_token) throw new Error("登录响应异常，请检查 Supabase 配置");
    const user = s.user || data.user;
    if (!user || !user.id) throw new Error("登录响应缺少用户信息");
    persistSession({ ...s, user });
    return session;
  }

  async function refreshSession() {
    if (!session || !session.refresh_token) throw new Error("登录已过期，请重新登录");
    const data = await authRequest("/auth/v1/token?grant_type=refresh_token", {
      refresh_token: session.refresh_token,
    });
    if (!data.access_token || !data.refresh_token) throw new Error("登录已过期，请重新登录");
    persistSession({ ...session, ...data, user: data.user || session.user });
    return session;
  }

  async function ensureSession() {
    if (!session) throw new Error("请先登录");
    if (session.expires_at && now() / 1000 > Number(session.expires_at) - 60) {
      await refreshSession();
    }
    return session;
  }

  async function signOut() {
    try {
      if (session && session.access_token) {
        await request("/auth/v1/logout", { method: "POST", token: session.access_token });
      }
    } catch (_) {}
    clearSession();
  }

  async function fetchRow() {
    const s = await ensureSession();
    if (!s.user || !s.user.id) throw new Error("登录状态异常，请重新登录");
    const data = await request(
      `/rest/v1/flashvocab_state?select=state,client_updated_at,updated_at&user_id=eq.${encodeURIComponent(s.user.id)}`,
      { token: s.access_token }
    );
    return Array.isArray(data) && data[0] ? data[0] : null;
  }

  async function push(force) {
    if (busy) return { busy: true };
    busy = true;
    try {
      const s = await ensureSession();
      const row = await fetchRow();
      const localTs = Number(App.state.updatedAt) || 0;
      const cloudHasData = row && hasStudyData(row.state);
      const localHasData = hasStudyData(App.state);
      if (!force && row && ((cloudHasData && !localHasData) || Number(row.client_updated_at) > localTs + 1000)) {
        return { conflict: true, row };
      }
      const ts = localTs || now();
      await request("/rest/v1/flashvocab_state?on_conflict=user_id", {
        method: "POST",
        token: s.access_token,
        prefer: "resolution=merge-duplicates,return=minimal",
        body: { user_id: s.user.id, state: App.state, client_updated_at: ts },
      });
      App.state.updatedAt = ts;
      App.saveState(false);
      return { ok: true, at: ts };
    } finally {
      busy = false;
    }
  }

  function normalizeCloudState(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    return {
      ...App.defaultState(),
      ...s,
      settings: { ...App.DEFAULT_SETTINGS, ...(s.settings || {}) },
      progress: s.progress && typeof s.progress === "object" ? s.progress : {},
      days: s.days && typeof s.days === "object" ? s.days : {},
      custom: Array.isArray(s.custom) ? s.custom : [],
    };
  }

  function hasStudyData(s) {
    if (!s || typeof s !== "object") return false;
    const progress = s.progress || {};
    const hasProgress = Object.values(progress).some((map) =>
      map && typeof map === "object" && Object.values(map).some((p) => p && (p.seen || p.box || p.due))
    );
    const hasCustom = Array.isArray(s.custom) && s.custom.length > 0;
    const days = s.days || {};
    const hasDays = Object.values(days).some(
      (d) => d && ((d.new || 0) + (d.review || 0) + (d.quiz && d.quiz.total ? d.quiz.total : 0) > 0)
    );
    return hasProgress || hasCustom || hasDays;
  }

  async function pull() {
    const row = await fetchRow();
    if (!row) {
      toastMsg("云端还没有备份，先点“上传本机”", "err");
      return;
    }
    const at = Number(row.client_updated_at) || 0;
    const ok = await App.confirmDialog(
      "恢复云端备份？",
      `云端备份时间：${fmtTime(at)}。恢复后会覆盖本机当前进度。`,
      "恢复云端"
    );
    if (!ok) {
      open();
      return;
    }
    const next = normalizeCloudState(row.state);
    next.updatedAt = at || now();
    App.closeModal();
    App.replaceState(next);
    App.toast("已恢复云端备份");
  }

  function onLocalSave() {
    if (!App || !cfg || !session || !App.state.settings.cloudAutoSync) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      push(false)
        .then((r) => {
          if (r && r.conflict) App.toast("云端有更新的备份，已暂停自动上传");
        })
        .catch((err) => console.warn("自动云同步失败", err));
    }, 1400);
  }

  async function checkNewer() {
    try {
      const row = await fetchRow();
      const cloudHasData = row && hasStudyData(row.state);
      const localHasData = hasStudyData(App.state);
      if (row && ((cloudHasData && !localHasData) || Number(row.client_updated_at) > (Number(App.state.updatedAt) || 0) + 1000)) {
        App.toast("云端有较新的备份，可在设置 → 云同步中恢复");
      }
    } catch (_) {}
  }

  function statusText() {
    if (!cfg) return "未配置 · 数据只存本机";
    if (!session) return "未登录 · 可连接云端";
    const user = currentUser();
    return user ? `已登录 ${user.name}` : "已登录";
  }

  function currentUser() {
    if (!session || !session.user) return null;
    const meta = session.user.user_metadata || {};
    const email = session.user.email || "";
    const fallback = email ? email.split("@")[0] : "";
    const name = String(meta.username || meta.name || fallback || "用户").trim();
    return { name, email };
  }

  function msg(text, kind) {
    const el = $("#cloudMsg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "cloud-msg" + (kind ? " " + kind : "");
  }

  function toastMsg(text, kind) {
    if (App && App.toast) App.toast(text);
    msg(text, kind);
  }

  function saveConfig(url, key) {
    const cleanUrl = String(url || "").trim().replace(/\/+$/, "");
    const cleanKey = assertClientKey(key);
    if (!/^https?:\/\//i.test(cleanUrl)) throw new Error("Project URL 需要以 http:// 或 https:// 开头");
    if (cleanKey.length < 20) throw new Error("anon public key 看起来不完整");
    const changed = !cfg || cfg.url !== cleanUrl;
    localStorage.setItem(CFG_KEY, JSON.stringify({ url: cleanUrl, anonKey: cleanKey }));
    cfg = readConfig();
    if (changed) clearSession();
  }

  /* ---------------- 弹窗 ---------------- */
  function open() {
    if (!App) return;
    cfg = readConfig();
    session = readSession();
    const head = `
      <div class="modal-head">
        <div><h3>云同步</h3><p>可选 · 数据保存在你自己的 Supabase 项目</p></div>
        <button class="modal-close" data-close aria-label="关闭">✕</button>
      </div>`;

    let body = "";
    if (!cfg) {
      body = `
        <div class="modal-body">
          ${keyWarning ? `<p class="cloud-msg err">${esc(keyWarning)}</p>` : ""}
          <p class="cloud-note">云同步需要一个免费的 Supabase 项目。数据存在你自己的 Supabase 项目里，由 Supabase 托管；本应用没有自己的后端。</p>
          <div class="cloud-steps">
            <div><b>1</b> 在 <a href="https://supabase.com" target="_blank" rel="noopener">supabase.com</a> 创建免费项目</div>
            <div><b>2</b> 在 SQL Editor 执行项目里的 <code>supabase/schema.sql</code></div>
            <div><b>3</b> 在 Project Settings → API 复制 URL 和 anon public key</div>
          </div>
          <div class="cloud-field"><label>Project URL</label><input class="cloud-input" id="cloudUrl" placeholder="https://xxxx.supabase.co" autocomplete="off" /></div>
          <div class="cloud-field"><label>anon public key</label><input class="cloud-input" id="cloudKey" placeholder="eyJhbGciOi..." autocomplete="off" /></div>
          <p class="cloud-note">只填 anon public key，不要填 service_role key。填错或泄露 service_role 会让数据库失去保护。</p>
          <p class="cloud-note">这一步只在当前浏览器生效。想让手机、电脑都免配置，把 URL 和 anon key 写进 <code>assets/cloud-config.js</code>，重新部署后所有设备打开就只差登录。</p>
          <div class="cloud-actions">
            <button class="btn btn-sm" id="cloudSaveCfg">保存配置</button>
            <button class="btn btn-ghost btn-sm" id="cloudTest">测试连接</button>
            <a class="btn btn-ghost btn-sm" href="https://supabase.com" target="_blank" rel="noopener">打开 Supabase</a>
          </div>
          <div class="cloud-msg" id="cloudMsg"></div>
        </div>`;
    } else if (!session) {
      body = `
        <div class="modal-body">
          <div class="cloud-kv"><span>Supabase</span><b class="cloud-host">${esc(hostOf(cfg.url))}</b></div>
          ${cfg.fromFile ? `<p class="cloud-note">本站已内置 Supabase 配置，换手机、换电脑都只需要用同一个邮箱密码登录，不用再填 URL 和 key。</p>` : ""}
          <p class="cloud-note">用邮箱注册或登录。注册后如果 Supabase 开启了邮箱确认，请先点邮件里的链接，再回来登录。</p>
          <div class="cloud-field"><label>用户名（注册时填写，可选）</label><input class="cloud-input" id="cloudUser" maxlength="20" placeholder="例如：小王" autocomplete="nickname" /></div>
          <div class="cloud-field"><label>邮箱</label><input class="cloud-input" id="cloudEmail" type="email" placeholder="you@example.com" autocomplete="email" /></div>
          <div class="cloud-field"><label>密码</label><input class="cloud-input" id="cloudPass" type="password" placeholder="至少 6 位" autocomplete="current-password" /></div>
          <div class="cloud-actions">
            <button class="btn btn-sm" id="cloudLogin">登录</button>
            <button class="btn btn-ghost btn-sm" id="cloudRegister">注册</button>
            <button class="btn btn-ghost btn-sm" id="cloudForgot">重置密码</button>
            ${cfg.fromFile ? "" : `<button class="btn btn-ghost btn-sm" id="cloudCfgEdit">修改配置</button>`}
          </div>
          <p class="cloud-note">忘记密码点「重置密码」，Supabase 会往邮箱发重置链接。这个邮箱如果从没注册过，请先点「注册」。</p>
          <div class="cloud-msg" id="cloudMsg"></div>
        </div>`;
    } else {
      const auto = !!App.state.settings.cloudAutoSync;
      const cu = currentUser() || { name: "", email: "" };
      body = `
        <div class="modal-body">
          <div class="cloud-kv"><span>用户名</span><b>${esc(cu.name)}</b></div>
          <div class="cloud-kv"><span>邮箱</span><b>${esc(cu.email)}</b></div>
          <div class="cloud-kv"><span>本机更新时间</span><b>${fmtTime(App.state.updatedAt)}</b></div>
          <div class="cloud-kv"><span>云端备份</span><b id="cloudRemote">读取中…</b></div>
          <div class="setting-row" style="padding:14px 0">
            <div><div class="s-label">自动上传</div><div class="s-desc">学习进度变化后自动同步到云端；云端更新时不会自动覆盖本机。</div></div>
            <div class="s-control"><button class="switch ${auto ? "on" : ""}" id="cloudAuto" role="switch" aria-checked="${auto}" aria-label="自动上传"></button></div>
          </div>
          <div class="cloud-actions">
            <button class="btn btn-sm" id="cloudPush">上传本机</button>
            <button class="btn btn-soft btn-sm" id="cloudPull">从云端恢复</button>
            <button class="btn btn-ghost btn-sm" id="cloudLogout">退出登录</button>
          </div>
          <p class="cloud-note">上传 = 用本机覆盖云端；恢复 = 用云端覆盖本机。云端比本机新时不会自动覆盖，请先确认两边数据。</p>
          <div class="cloud-msg" id="cloudMsg"></div>
        </div>`;
    }

    App.openModal(
      head + body + `<div class="modal-foot"><button class="btn btn-soft btn-sm" data-close>关闭</button></div>`
    );
    App.setAfterClose(() => App.openSettings());

    if (!cfg) bindConfig();
    else if (!session) bindAuth();
    else bindSignedIn();
  }

  function bindConfig() {
    const btn = $("#cloudSaveCfg");
    if (!btn) return;
    btn.addEventListener("click", () => {
      try {
        saveConfig($("#cloudUrl").value, $("#cloudKey").value);
        App.toast("云同步配置已保存");
        open();
      } catch (err) {
        msg(describeError(err), "err");
      }
    });
    const test = $("#cloudTest");
    if (test) {
      test.addEventListener("click", async () => {
        try {
          saveConfig($("#cloudUrl").value, $("#cloudKey").value);
        } catch (err) {
          return msg(describeError(err), "err");
        }
        msg("测试中…");
        try {
          msg(await probeProject(), "ok");
        } catch (err) {
          msg(describeError(err), "err");
        }
      });
    }
  }

  /* 登录后：本机是空的就从云端恢复；本机有数据就打开自动上传 */
  async function afterLogin(opts = {}) {
    try {
      const row = await fetchRow().catch(() => null);
      const cloudHas = row && hasStudyData(row.state);
      if (!hasStudyData(App.state) && cloudHas) {
        App.toast("云端有备份，正在恢复…");
        await pull();
        return;
      }
      if (!App.state.settings.cloudAutoSync) {
        App.state.settings.cloudAutoSync = true;
        App.saveState(false);
      }
      if (opts.freshAccount && !cloudHas && hasStudyData(App.state)) {
        App.toast("已登录，之后的学习进度会自动同步");
      }
    } catch (_) {}
  }

  function bindAuth() {
    const doAuth = async (kind) => {
      const email = ($("#cloudEmail").value || "").trim();
      const pass = $("#cloudPass").value || "";
      const username = ($("#cloudUser").value || "").trim();
      if (!email || !email.includes("@")) return msg("请输入有效邮箱", "err");
      if (pass.length < 6) return msg("密码至少 6 位", "err");
      msg(kind === "login" ? "登录中…" : "注册中…");
      try {
        if (kind === "login") {
          await signIn(email, pass);
          App.refreshIdentity();
          App.toast("登录成功");
          await afterLogin();
          open();
        } else {
          const r = await signUp(email, pass, username);
          if (r.session) {
            App.refreshIdentity();
            App.toast("注册并登录成功");
            await afterLogin({ freshAccount: true });
            open();
          } else {
            msg("注册请求已提交。如果项目开启了邮箱确认，请先点邮件里的链接，再回来点「登录」。", "ok");
          }
        }
      } catch (err) {
        msg(describeError(err), "err");
      }
    };
    $("#cloudLogin").addEventListener("click", () => doAuth("login"));
    $("#cloudRegister").addEventListener("click", () => doAuth("register"));
    const forgot = $("#cloudForgot");
    if (forgot) {
      forgot.addEventListener("click", async () => {
        const email = ($("#cloudEmail").value || "").trim();
        if (!email || !email.includes("@")) return msg("先填邮箱，再点重置密码", "err");
        msg("发送中…");
        try {
          await sendRecovery(email);
          msg("如果这个邮箱已注册，重置邮件已经发出，去收件箱点链接设置新密码。", "ok");
        } catch (err) {
          msg(describeError(err), "err");
        }
      });
    }
    $("#cloudPass").addEventListener("keydown", (e) => {
      if (e.key === "Enter") doAuth("login");
    });
    const edit = $("#cloudCfgEdit");
    if (edit) {
      edit.addEventListener("click", () => {
        try { localStorage.removeItem(CFG_KEY); } catch (_) {}
        clearSession();
        open();
      });
    }
  }

  function bindSignedIn() {
    const remote = $("#cloudRemote");
    const refreshRemote = async () => {
      try {
        const row = await fetchRow();
        if (!remote || !document.body.contains(remote)) return;
        if (!row) {
          remote.textContent = "暂无备份";
          return;
        }
        const at = Number(row.client_updated_at) || 0;
        remote.textContent = fmtTime(at) + (at > (Number(App.state.updatedAt) || 0) + 1000 ? " · 比本机新" : "");
      } catch (err) {
        if (remote) remote.textContent = "读取失败";
      }
    };
    refreshRemote();

    $("#cloudAuto").addEventListener("click", (e) => {
      const on = !App.state.settings.cloudAutoSync;
      App.state.settings.cloudAutoSync = on;
      e.currentTarget.classList.toggle("on", on);
      e.currentTarget.setAttribute("aria-checked", String(on));
      App.saveState();
      msg(on ? "已开启自动上传" : "已关闭自动上传", "ok");
    });

    $("#cloudPush").addEventListener("click", async () => {
      msg("上传中…");
      try {
        let r = await push(false);
        if (r && r.conflict) {
          const ok = await App.confirmDialog(
            "云端备份更新",
            "云端备份比本机新。继续上传会用本机数据覆盖云端，确定吗？",
            "仍然上传"
          );
          if (!ok) {
            open();
            return;
          }
          r = await push(true);
        }
        if (r && r.ok) {
          App.toast("已上传到云端");
          open();
        } else if (r && r.busy) {
          msg("正在同步，请稍后再试");
        }
      } catch (err) {
        const text = describeError(err);
        msg(text, "err");
        if (!$("#cloudMsg")) App.toast(text);
      }
    });

    $("#cloudPull").addEventListener("click", async () => {
      try {
        await pull();
      } catch (err) {
        const text = describeError(err);
        msg(text, "err");
        if (!$("#cloudMsg")) App.toast(text);
      }
    });

    $("#cloudLogout").addEventListener("click", async () => {
      await signOut();
      App.refreshIdentity();
      App.toast("已退出云同步");
      open();
    });
  }

  async function init(app) {
    App = app;
    cfg = readConfig();
    session = readSession();
    App.refreshIdentity();
    if (!cfg || !session) return;
    try {
      await ensureSession();
      App.refreshIdentity();
      checkNewer();
    } catch (err) {
      if (err.status === 400 || err.status === 401) clearSession();
      App.refreshIdentity();
    }
  }

  window.FlashVocabCloud = { init, open, onLocalSave, statusText, currentUser };
})();
