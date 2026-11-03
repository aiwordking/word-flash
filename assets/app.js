/* ============================================================
   闪词 FlashVocab — 选词库，马上背
   纯前端 · 本地存储 · 无构建步骤
   ============================================================ */
(() => {
  "use strict";

  /* ---------------- 基础工具 ---------------- */
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const sample = (arr, n) => shuffle(arr).slice(0, n);
  const keyOf = (w) => String(w).trim().toLowerCase();
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  const pad = (n) => String(n).padStart(2, "0");
  const dayKey = (d = new Date()) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  };
  const WEEK_CN = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

  /* Leitner 间隔：box 0-6 对应下次复习时间 */
  const INTERVALS = [10 * MIN, 1 * DAY, 2 * DAY, 4 * DAY, 7 * DAY, 15 * DAY, 30 * DAY];
  const MASTER_BOX = 4;

  /* ---------------- 数据 ---------------- */
  const BUILTIN = Array.isArray(window.WORDBOOKS) ? window.WORDBOOKS : [];
  const STORE_KEY = "flashvocab.v1";
  const DEFAULT_SETTINGS = {
    dailyNew: 20,
    autoSpeak: true,
    accent: "en-US",
    theme: "dark",
    mode: "en-zh",
    lastBook: "",
    cloudAutoSync: false,
  };

  const defaultState = () => ({
    settings: { ...DEFAULT_SETTINGS },
    progress: {},
    days: {},
    custom: [],
    createdAt: Date.now(),
    /* 0 表示还没有本地修改；避免新设备空状态被误判成比云端新 */
    updatedAt: 0,
  });

  let state = loadState();
  let view = "home";
  let session = null;
  let quiz = null;
  let quizSetup = { bookId: "", count: 10, dir: "en-zh" };
  let studyBookId = "";
  let toastTimer = null;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return {
        ...defaultState(),
        ...parsed,
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        progress: parsed.progress && typeof parsed.progress === "object" ? parsed.progress : {},
        days: parsed.days && typeof parsed.days === "object" ? parsed.days : {},
        custom: Array.isArray(parsed.custom) ? parsed.custom : [],
        /* 老数据没有 updatedAt 时视为 0，避免把本机误判成比云端新 */
        updatedAt: Number(parsed.updatedAt) || 0,
      };
    } catch (err) {
      console.warn("读取本地数据失败", err);
      return defaultState();
    }
  }

  function saveState(touch = true) {
    if (touch) state.updatedAt = Date.now();
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (err) {
      console.warn("保存失败", err);
      toast("本地存储空间不足，部分进度可能未保存");
    }
    if (touch) window.FlashVocabCloud?.onLocalSave?.();
  }

  function allBooks() {
    return BUILTIN.slice();
  }
  function findBook(id) {
    return allBooks().find((b) => b.id === id) || null;
  }
  function activeBook() {
    return findBook(state.settings.lastBook) || allBooks()[0] || null;
  }

  /* ---------------- 进度 ---------------- */
  function progressMap(bookId) {
    if (!state.progress[bookId]) state.progress[bookId] = {};
    return state.progress[bookId];
  }
  function getProgress(bookId, word) {
    const map = state.progress[bookId];
    return map ? map[keyOf(word.w)] : undefined;
  }
  function ensureProgress(bookId, word) {
    const map = progressMap(bookId);
    const k = keyOf(word.w);
    if (!map[k]) {
      map[k] = { box: 0, due: 0, seen: 0, right: 0, wrong: 0, last: 0 };
    }
    return map[k];
  }

  function bookStats(book) {
    const map = state.progress[book.id] || {};
    const now = Date.now();
    let seen = 0, mastered = 0, learning = 0, due = 0;
    for (const w of book.words) {
      const p = map[keyOf(w.w)];
      if (!p) continue;
      seen++;
      if (p.box >= MASTER_BOX) mastered++;
      else learning++;
      if (p.box < 6 && (p.due || 0) <= now) due++;
    }
    return { seen, mastered, learning, due, total: book.words.length };
  }

  function globalStats() {
    let seen = 0, mastered = 0, learning = 0, fresh = 0, right = 0, wrong = 0, due = 0;
    const now = Date.now();
    for (const book of allBooks()) {
      const map = state.progress[book.id] || {};
      for (const w of book.words) {
        const p = map[keyOf(w.w)];
        if (!p) continue;
        seen++;
        right += p.right || 0;
        wrong += p.wrong || 0;
        if (p.box >= MASTER_BOX) mastered++;
        else if (p.box >= 1) learning++;
        else fresh++;
        if (p.box < 6 && (p.due || 0) <= now) due++;
      }
    }
    return { seen, mastered, learning, fresh, right, wrong, due };
  }

  function dayStats(key = dayKey()) {
    if (!state.days[key]) {
      state.days[key] = { new: 0, review: 0, right: 0, wrong: 0, ms: 0 };
    }
    return state.days[key];
  }
  function todayStats() {
    return dayStats(dayKey());
  }
  function hasActivity(key) {
    const d = state.days[key];
    return !!d && ((d.new || 0) + (d.review || 0) > 0 || (d.quiz && d.quiz.total > 0));
  }
  function calcStreak() {
    let n = 0;
    const d = new Date();
    if (!hasActivity(dayKey(d))) d.setDate(d.getDate() - 1);
    while (hasActivity(dayKey(d))) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }

  /* ---------------- TTS ---------------- */
  let voiceCache = [];
  function loadVoices() {
    if (!("speechSynthesis" in window)) return;
    voiceCache = window.speechSynthesis.getVoices() || [];
  }
  if ("speechSynthesis" in window) {
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }
  function speak(text, force) {
    if (!("speechSynthesis" in window)) {
      if (force) toast("当前浏览器不支持语音朗读");
      return;
    }
    if (!text) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const lang = state.settings.accent || "en-US";
      u.lang = lang;
      u.rate = 0.92;
      const pool = voiceCache.length ? voiceCache : window.speechSynthesis.getVoices();
      const exact = pool.find((v) => v.lang.replace("_", "-") === lang);
      const anyEn = pool.find((v) => v.lang.toLowerCase().startsWith("en"));
      if (exact) u.voice = exact;
      else if (anyEn) u.voice = anyEn;
      window.speechSynthesis.speak(u);
    } catch (err) {
      console.warn("发音失败", err);
    }
  }

  /* ---------------- 会话队列 ---------------- */
  function collectQueue(book) {
    const map = state.progress[book.id] || {};
    const now = Date.now();
    const due = [], fresh = [];
    for (const w of book.words) {
      const p = map[keyOf(w.w)];
      if (!p) fresh.push(w);
      else if (p.box < 6 && (p.due || 0) <= now) due.push(w);
    }
    const allowance = Math.max(0, state.settings.dailyNew - todayStats().new);
    return { due, fresh, newLimit: Math.min(fresh.length, allowance) };
  }

  function interleave(due, fresh) {
    const out = [];
    let di = 0, fi = 0;
    while (di < due.length || fi < fresh.length) {
      for (let k = 0; k < 2 && di < due.length; k++) out.push(due[di++]);
      if (fi < fresh.length) out.push(fresh[fi++]);
    }
    return out;
  }

  function startSession(bookId, opts = {}) {
    const book = findBook(bookId);
    if (!book) return;
    const { due, fresh, newLimit } = collectQueue(book);
    let queue = [];
    if (opts.free) {
      queue = sample(book.words, 20);
    } else {
      queue = interleave(shuffle(due), shuffle(fresh).slice(0, newLimit));
    }
    session = {
      bookId: book.id,
      bookName: book.name,
      mode: state.settings.mode || "en-zh",
      queue: queue.map((w) => ({
        word: w,
        isNew: !getProgress(book.id, w),
        again: false,
      })),
      total: queue.length,
      idx: 0,
      revealed: false,
      spellValue: "",
      spellChecked: false,
      spellOk: false,
      stats: { known: 0, fuzzy: 0, unknown: 0 },
      start: Date.now(),
      free: !!opts.free,
      spokenFor: -1,
      busy: false,
    };
    state.settings.lastBook = book.id;
    saveState();
    setView("study");
  }

  /* ---------------- 训练动作 ---------------- */
  function currentItem() {
    if (!session) return null;
    return session.queue[session.idx] || null;
  }

  function reveal() {
    if (!session || session.revealed) return;
    session.revealed = true;
    renderStudy();
    const item = currentItem();
    if (item && session.mode === "zh-en" && state.settings.autoSpeak) {
      speak(item.word.w);
    }
  }

  function rate(rating) {
    if (!session || session.busy) return;
    const item = session.queue[session.idx];
    if (!item) return;
    session.busy = true;

    const book = findBook(session.bookId);
    const p = ensureProgress(session.bookId, item.word);
    const now = Date.now();

    p.seen = (p.seen || 0) + 1;
    p.last = now;

    if (rating === "known") {
      p.box = Math.min(6, (p.box || 0) + 1);
      p.right = (p.right || 0) + 1;
      p.due = now + INTERVALS[p.box];
    } else if (rating === "fuzzy") {
      p.box = Math.max(1, Math.min(6, p.box || 1));
      p.wrong = (p.wrong || 0) + 1;
      p.due = now + 12 * HOUR;
    } else {
      p.box = 0;
      p.wrong = (p.wrong || 0) + 1;
      p.due = now + 5 * MIN;
    }

    const d = todayStats();
    if (item.isNew) d.new = (d.new || 0) + 1;
    else d.review = (d.review || 0) + 1;
    if (rating === "known") d.right = (d.right || 0) + 1;
    else d.wrong = (d.wrong || 0) + 1;

    session.stats[rating]++;

    /* 不认识的词，本组末尾再出现一次 */
    if (rating === "unknown" && !item.again) {
      session.queue.push({ ...item, isNew: false, again: true });
      session.total = session.queue.length;
    }

    session.idx++;
    session.revealed = false;
    session.spellValue = "";
    session.spellChecked = false;
    session.spellOk = false;
    session.spokenFor = -1;
    saveState();

    setTimeout(() => {
      if (!session) return;
      session.busy = false;
      renderStudy();
    }, 160);
  }

  function checkSpell() {
    if (!session || session.revealed) return;
    const input = $("#spellInput");
    const value = input ? input.value : session.spellValue;
    const item = currentItem();
    if (!item) return;
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
    const ok = norm(value) === norm(item.word.w);
    session.spellValue = value;
    session.spellChecked = true;
    session.spellOk = ok;
    session.revealed = true;
    renderStudy();
  }

  /* ---------------- 视图切换 ---------------- */
  function setView(v, opts = {}) {
    view = v;
    if (v === "study" && !session) {
      studyBookId = state.settings.lastBook || (allBooks()[0] && allBooks()[0].id) || "";
    }
    if (v === "quiz" && !quiz) {
      quizSetup.bookId = quizSetup.bookId || state.settings.lastBook || (allBooks()[0] && allBooks()[0].id) || "";
    }
    render();
    if (!opts.keepScroll) window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    $$(".tab, .desk-link").forEach((t) => t.classList.toggle("active", t.dataset.nav === v));
  }

  function render() {
    if (view === "home") renderHome();
    else if (view === "study") renderStudy();
    else if (view === "quiz") renderQuiz();
    else if (view === "stats") renderStats();
    const focus =
      (view === "study" && session && session.queue.length > 0 && session.idx < session.queue.length) ||
      (view === "quiz" && quiz && quiz.phase === "play");
    document.body.classList.toggle("focus-mode", !!focus);
    updateStreakChip();
  }

  function updateStreakChip() {
    const el = $("#streakNum");
    if (el) el.textContent = calcStreak();
  }

  function updateUserChip() {
    const chip = $("#userChip");
    const loginChip = $("#loginChip");
    const nameEl = $("#userName");
    const avatar = $("#userAvatar");
    if (!chip || !nameEl || !avatar) return;
    const user = window.FlashVocabCloud?.currentUser?.();
    const name = user && user.name ? String(user.name).trim() : "";
    if (!name) {
      chip.hidden = true;
      if (loginChip) loginChip.hidden = false;
      return;
    }
    chip.hidden = false;
    if (loginChip) loginChip.hidden = true;
    nameEl.textContent = name;
    avatar.textContent = Array.from(name)[0].toUpperCase();
    chip.title = `云同步：${name}`;
  }

  /* ---------------- 首页 ---------------- */
  function renderHome() {
    const books = allBooks();
    const totalWords = books.reduce((n, b) => n + b.words.length, 0);
    const g = globalStats();
    const t = todayStats();
    const streak = calcStreak();
    const goal = state.settings.dailyNew;
    const last = activeBook();
    const now = new Date();
    const hour = now.getHours();
    const greet = hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
    const userName = window.FlashVocabCloud?.currentUser?.()?.name || "同学";
    const dateStr = `${now.getMonth() + 1}月${now.getDate()}日 · ${WEEK_CN[now.getDay()]}`;
    const pct = clamp(t.new / Math.max(1, goal), 0, 1);
    const circumference = 2 * Math.PI * 52;

    let title;
    let sub;
    if (t.new >= goal && g.due === 0) {
      title = `今日任务已完成 <span class="accent">🎉</span>`;
      sub = "新词目标和到期复习都清空了。想多背一点，随时开启自由加练。";
    } else if (t.new >= goal) {
      title = `今天还有 <span class="accent">${g.due}</span> 个词待复习`;
      sub = "新词目标已完成，把到期的词过一遍，记忆会更牢。";
    } else {
      title = `今天背 <span class="accent">${goal}</span> 个词`;
      sub = `已学 ${t.new} 个新词 · ${g.due} 个到期复习，预计 ${Math.max(3, Math.round((goal - t.new) * 0.5 + g.due * 0.15))} 分钟。`;
    }

    const cards = books.map((book) => {
      const s = bookStats(book);
      const pctSeen = s.total ? (s.seen / s.total) * 100 : 0;
      return `
        <div class="book-card" style="--c:${esc(book.color || "#ffd60a")}" data-book="${esc(book.id)}" role="button" tabindex="0" aria-label="开始学习 ${esc(book.name)}">
          <div class="book-top">
            <i class="book-dot"></i>
            <span class="book-tag">${esc(book.tag || "词库")}</span>
            <span class="book-go">↗</span>
          </div>
          <h3>${esc(book.name)}</h3>
          <p>${esc(book.desc || "")}</p>
          <div class="book-meta">
            <span><b>${s.seen}</b> / ${s.total} 已学</span>
            <span>${s.mastered} 掌握</span>
          </div>
          <div class="bar"><i style="width:${pctSeen.toFixed(1)}%"></i></div>
        </div>`;
    }).join("");

    $("#view").innerHTML = `
      <section class="page">
        <div class="hello">
          <p class="eyebrow">${dateStr}</p>
          <h1>${greet}，<span class="hello-name">${esc(userName)}</span>。<br>今天背 <span class="accent">${goal}</span> 个词。</h1>
          <p class="sub">卡片速记 + 间隔复习，把「见过」变成「记住」。</p>
        </div>

        <div class="home-grid">
          <div class="panel task-card">
            <div class="task-main">
              <div class="task-label"><i class="dot"></i>今日任务${last ? ` · ${esc(last.name)}` : ""}</div>
              <h2 class="task-title">${title}</h2>
              <p class="task-sub">${sub}</p>
              <div class="task-chips">
                <span class="chip-mini">待复习 <b>${g.due}</b></span>
                <span class="chip-mini">今日已学 <b>${t.new + t.review}</b></span>
                <span class="chip-mini">已掌握 <b>${g.mastered}</b></span>
              </div>
              <div class="task-actions">
                <button class="btn" id="startBtn">开始学习
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
                </button>
                <button class="btn btn-ghost" id="quickQuiz">小测一下</button>
              </div>
            </div>
            <div class="ring-wrap">
              <svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
                <defs>
                  <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stop-color="#ffd60a"/><stop offset="1" stop-color="#ff9f0a"/>
                  </linearGradient>
                </defs>
                <circle class="track" cx="60" cy="60" r="52" fill="none" stroke-width="8"/>
                <circle class="meter" id="ringMeter" cx="60" cy="60" r="52" fill="none" stroke-width="8"
                  stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${circumference.toFixed(1)}"/>
              </svg>
              <div class="ring-center">
                <b>${t.new}<span style="font-size:13px;color:var(--muted);font-weight:600">/${goal}</span></b>
                <span>今日新词</span>
              </div>
            </div>
          </div>

          <div class="quick-stats">
            <div class="quick-stat">
              <span class="qs-label"><span class="qs-icon" style="background:var(--amber-soft)">🔥</span>连续学习</span>
              <b>${streak}<small>天</small></b>
            </div>
            <div class="quick-stat">
              <span class="qs-label"><span class="qs-icon" style="background:var(--green-soft)">🎯</span>已掌握</span>
              <b>${g.mastered}<small>词</small></b>
            </div>
            <div class="quick-stat">
              <span class="qs-label"><span class="qs-icon" style="background:rgba(91,140,255,.12)">📚</span>词库总量</span>
              <b>${totalWords}<small>词</small></b>
            </div>
          </div>
        </div>

        <div class="section-head">
          <h2>选择词库</h2>
          <span class="meta">${books.length} 个词库 · ${totalWords} 词</span>
        </div>
        <div class="book-grid">
          ${cards}
        </div>
      </section>`;

    const meter = $("#ringMeter");
    if (meter) {
      requestAnimationFrame(() => {
        meter.style.strokeDashoffset = String(circumference * (1 - pct));
      });
    }

    $("#startBtn").addEventListener("click", () => {
      if (last) startSession(last.id);
    });
    $("#quickQuiz").addEventListener("click", () => {
      quiz = null;
      quizSetup.bookId = last ? last.id : quizSetup.bookId;
      setView("quiz");
    });
    bindBookCards();
  }

  function bindBookCards() {
    $$("#view [data-book]").forEach((card) => {
      const go = () => startSession(card.dataset.book);
      card.addEventListener("click", (e) => {
        go();
      });
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });
    });
  }

  /* ---------------- 学习 ---------------- */
  function renderStudy() {
    if (!session) {
      renderStudyLanding();
      return;
    }
    if (!session.queue.length) {
      renderSessionEmpty(findBook(session.bookId) || { name: "词库" });
      return;
    }
    if (session.idx >= session.queue.length) {
      renderSessionDone();
      return;
    }
    const item = currentItem();
    const w = item.word;
    const mode = session.mode;
    const total = Math.max(1, session.total);
    const pct = clamp(session.idx / total, 0, 1) * 100;

    const badge = item.isNew
      ? `<span class="badge new">● 新词</span>`
      : `<span class="badge review">↻ 复习${item.again ? " · 再来一次" : ""}</span>`;

    let main = "";
    if (mode === "spell") {
      if (!session.revealed) {
        main = `
          <div class="card-main">
            <div class="meaning">${esc(w.m)}</div>
            ${w.p ? `<div class="phonetic">${esc(w.p)}</div>` : ""}
            <div class="spell-box">
              <input class="spell-input" id="spellInput" autocomplete="off" autocapitalize="off"
                spellcheck="false" placeholder="输入英文单词…" aria-label="拼写单词" value="${esc(session.spellValue)}" />
              <div class="spell-feedback" id="spellFeedback">按 Enter 检查拼写</div>
            </div>
          </div>`;
      } else {
        main = `
          <div class="card-back">
            <div class="word">${esc(w.w)}</div>
            ${w.p ? `<div class="phonetic">${esc(w.p)}</div>` : ""}
            <div class="meaning" style="margin-top:16px">${esc(w.m)}</div>
            <div class="spell-feedback ${session.spellOk ? "ok" : "bad"}" style="font-size:14px;margin-top:18px">
              ${session.spellOk ? "✓ 拼写正确" : `✕ 你的拼写：${esc(session.spellValue || "（空）")} · 正确拼写：${esc(w.w)}`}
            </div>
            ${w.e ? `<p class="example">${esc(w.e)}</p>` : ""}
          </div>`;
      }
    } else if (!session.revealed) {
      const front = mode === "zh-en" ? w.m : w.w;
      main = `
        <div class="card-main">
          ${mode === "zh-en" ? `<div class="meaning">${esc(front)}</div>` : `<div class="word">${esc(front)}</div>`}
          ${mode === "en-zh" && w.p ? `<div class="phonetic">${esc(w.p)}</div>` : ""}
          <div class="hint">点击卡片或按 <span class="kbd">空格</span> 显示${mode === "zh-en" ? "单词" : "释义"}</div>
        </div>`;
    } else {
      main = `
        <div class="card-back">
          ${mode === "zh-en" ? `<div class="meaning" style="margin-bottom:18px">${esc(w.m)}</div>` : ""}
          <div class="word" style="${mode === "zh-en" ? "font-size:clamp(32px,6vw,48px)" : ""}">${esc(w.w)}</div>
          ${w.p ? `<div class="phonetic">${esc(w.p)}</div>` : ""}
          ${mode === "en-zh" ? `<div class="meaning" style="margin-top:18px">${esc(w.m)}</div>` : ""}
          ${w.e ? `<p class="example">${esc(w.e)}</p>` : ""}
          <div class="hint">滑动手势：左滑「不认识」· 右滑「认识」</div>
        </div>`;
    }

    let actions = "";
    if (mode === "spell") {
      actions = session.revealed
        ? `<button class="btn btn-wide" id="spellNext">继续
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
           </button>`
        : `<button class="btn btn-wide" id="checkSpell">检查拼写</button>`;
    } else if (session.revealed) {
      actions = `
        <div class="rating-row">
          <button class="rate-btn unknown" data-rate="unknown">不认识 <kbd>1</kbd></button>
          <button class="rate-btn fuzzy" data-rate="fuzzy">模糊 <kbd>2</kbd></button>
          <button class="rate-btn known" data-rate="known">认识 <kbd>3</kbd></button>
        </div>`;
    } else {
      actions = `<button class="btn btn-wide btn-soft" id="revealBtn">显示${mode === "zh-en" ? "单词" : "释义"}（空格）</button>`;
    }

    $("#view").innerHTML = `
      <section class="page">
        <div class="study-head">
          <button class="study-back" id="exitStudy" aria-label="退出学习">←</button>
          <div class="study-meta">
            <div class="sm-book">${esc(session.bookName)}</div>
            <h2>${session.mode === "spell" ? "拼写训练" : session.mode === "zh-en" ? "中 → 英回想" : "英 → 中速记"}</h2>
          </div>
          <div class="study-count"><b>${session.idx + 1}</b> / ${session.total}</div>
        </div>
        <div class="session-bar"><i style="width:${pct}%"></i></div>

        <div class="stage">
          <div class="stage-stack">
            <div class="card-ghost" aria-hidden="true"></div>
            <article class="flashcard enter" id="flashcard">
              <div class="swipe-stamp stamp-left">不认识</div>
              <div class="swipe-stamp stamp-right">认识</div>
              <div class="card-top">
                ${badge}
                <div class="card-tools">
                  ${(session.mode === "spell" || session.mode === "zh-en") && !session.revealed
                    ? ""
                    : `<button class="speak-btn" id="speakBtn" aria-label="朗读单词" title="朗读单词">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>
                      </button>`}
                </div>
              </div>
              ${main}
            </article>
          </div>
          <div class="session-actions">${actions}</div>
        </div>
      </section>`;

    bindStudy();
  }

  function bindStudy() {
    const card = $("#flashcard");
    const item = currentItem();
    if (!card || !item) return;
    const w = item.word;

    $("#exitStudy").addEventListener("click", () => {
      session = null;
      setView("study");
    });

    const speakBtn = $("#speakBtn");
    if (speakBtn) {
      speakBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        speakBtn.classList.add("playing");
        speak(w.w, true);
        setTimeout(() => speakBtn.classList.remove("playing"), 700);
      });
    }

    const revealBtn = $("#revealBtn");
    if (revealBtn) revealBtn.addEventListener("click", reveal);

    const checkBtn = $("#checkSpell");
    if (checkBtn) checkBtn.addEventListener("click", checkSpell);

    const spellNext = $("#spellNext");
    if (spellNext) {
      spellNext.addEventListener("click", () => rate(session.spellOk ? "known" : "unknown"));
    }

    $$("#view [data-rate]").forEach((btn) => {
      btn.addEventListener("click", () => rate(btn.dataset.rate));
    });

    const input = $("#spellInput");
    if (input) {
      input.focus();
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          checkSpell();
        }
      });
      input.addEventListener("input", () => {
        session.spellValue = input.value;
      });
    }

    /* 自动发音 */
    if (state.settings.autoSpeak && session.spokenFor !== session.idx) {
      if (session.mode === "en-zh" && !session.revealed) {
        session.spokenFor = session.idx;
        setTimeout(() => speak(w.w), 120);
      } else if (session.mode === "zh-en" && session.revealed) {
        session.spokenFor = session.idx;
        setTimeout(() => speak(w.w), 120);
      }
    }

    /* 点击翻面 */
    card.addEventListener("click", (e) => {
      if (e.target.closest(".speak-btn")) return;
      if (session.mode === "spell") return;
      if (!session.revealed) reveal();
    });

    /* 滑动评分 */
    let active = false, dragging = false, startX = 0, startY = 0, dx = 0;
    card.addEventListener("pointerdown", (e) => {
      if (e.button && e.button !== 0) return;
      if (!session.revealed || session.mode === "spell") return;
      if (e.target.closest(".speak-btn")) return;
      active = true;
      dragging = false;
      startX = e.clientX;
      startY = e.clientY;
      dx = 0;
      try { card.setPointerCapture(e.pointerId); } catch (_) {}
    });
    card.addEventListener("pointermove", (e) => {
      if (!active) return;
      dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        dragging = true;
        card.classList.add("dragging");
      }
      if (!dragging) return;
      card.style.transform = `translateX(${dx}px) rotate(${dx / 28}deg)`;
      const l = $(".stamp-left", card);
      const r = $(".stamp-right", card);
      if (l) l.style.opacity = dx < 0 ? String(clamp(-dx / 100, 0, 1)) : "0";
      if (r) r.style.opacity = dx > 0 ? String(clamp(dx / 100, 0, 1)) : "0";
    });
    const endDrag = () => {
      if (!active) return;
      active = false;
      if (!dragging) {
        card.style.transform = "";
        return;
      }
      card.classList.remove("dragging");
      if (Math.abs(dx) > 90) {
        const right = dx > 0;
        card.classList.add(right ? "gone-right" : "gone-left");
        setTimeout(() => rate(right ? "known" : "unknown"), 180);
      } else {
        card.style.transform = "";
        const l = $(".stamp-left", card);
        const r = $(".stamp-right", card);
        if (l) l.style.opacity = "0";
        if (r) r.style.opacity = "0";
      }
    };
    card.addEventListener("pointerup", endDrag);
    card.addEventListener("pointercancel", endDrag);
  }

  function renderStudyLanding() {
    const books = allBooks();
    if (!books.length) {
      $("#view").innerHTML = `<div class="session-empty panel"><div class="big">📚</div><h2>词库还没加载</h2><p>刷新页面再试一次。</p></div>`;
      return;
    }
    if (!studyBookId || !findBook(studyBookId)) {
      studyBookId = findBook(state.settings.lastBook) ? state.settings.lastBook : books[0].id;
    }
    const book = findBook(studyBookId) || books[0];
    const q = collectQueue(book);
    const t = todayStats();
    const planCount = q.due.length + q.newLimit;
    const mode = state.settings.mode || "en-zh";
    const bstat = bookStats(book);
    const seenPct = book.words.length ? Math.round((bstat.seen / book.words.length) * 100) : 0;

    $("#view").innerHTML = `
      <section class="page">
        <div class="page-head">
          <p class="eyebrow">STUDY</p>
          <h1>开始今天的学习</h1>
          <p>选一个词库，按自己的节奏背。到期复习会自动混进队列。</p>
        </div>

        <div class="setup-card panel">
          <div class="field">
            <div class="field-label">选择词库 <span>${books.length} 个可用</span></div>
            <div class="chip-grid" id="studyBooks">
              ${books.map((b) => {
                const s = bookStats(b);
                return `<button class="chip ${b.id === book.id ? "active" : ""}" data-sbook="${esc(b.id)}" style="--c:${esc(b.color || "#ffd60a")}">
                  <i class="dot"></i><span>${esc(b.name)}</span><span class="n">${s.due ? `${s.due} 待复习` : `${b.words.length} 词`}</span>
                </button>`;
              }).join("")}
            </div>
          </div>

          <div class="field">
            <div class="field-label">学习方式 <span>可随时切换</span></div>
            <div class="seg" id="modeSeg">
              <button data-mode="en-zh" class="${mode === "en-zh" ? "active" : ""}">英 → 中</button>
              <button data-mode="zh-en" class="${mode === "zh-en" ? "active" : ""}">中 → 英</button>
              <button data-mode="spell" class="${mode === "spell" ? "active" : ""}">拼写</button>
            </div>
          </div>

          <div class="plan-box">
            <div class="plan-item"><b>${q.due.length}</b><span>到期复习</span></div>
            <div class="plan-item"><b>${q.newLimit}</b><span>今日新词</span></div>
            <div class="plan-item"><b>${bstat.mastered}</b><span>已掌握</span></div>
            <div class="plan-item"><b>${seenPct}<small style="font-size:12px;color:var(--muted)">%</small></b><span>词库进度</span></div>
          </div>

          <div class="setup-actions">
            <button class="btn" id="beginStudy" ${planCount === 0 ? "disabled" : ""}>
              开始学习${planCount ? ` · ${planCount} 词` : ""}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            </button>
            ${planCount === 0 ? `<button class="btn btn-ghost" id="freeStudy2">自由加练 20 词</button>` : ""}
          </div>
          <p class="hint-block">${planCount === 0
            ? "这个词库今天没有待学内容：新词额度已用完，也没有到期复习。可以自由加练，或用其他词库。"
            : `完成今日 ${state.settings.dailyNew} 个新词目标后，新词会自动停止，只保留复习。可在右上角设置里调整目标。`}</p>
        </div>
      </section>`;

    $$("#studyBooks [data-sbook]").forEach((chip) => {
      chip.addEventListener("click", () => {
        studyBookId = chip.dataset.sbook;
        renderStudyLanding();
      });
    });
    $$("#modeSeg [data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.settings.mode = btn.dataset.mode;
        saveState();
        renderStudyLanding();
      });
    });
    const begin = $("#beginStudy");
    if (begin) {
      begin.addEventListener("click", () => startSession(book.id));
    }
    const free = $("#freeStudy2");
    if (free) free.addEventListener("click", () => startSession(book.id, { free: true }));
  }

  function renderSessionDone() {
    const total = session.idx;
    const { known, fuzzy, unknown } = session.stats;
    const book = findBook(session.bookId);
    const mins = Math.max(1, Math.round((Date.now() - session.start) / 60000));

    $("#view").innerHTML = `
      <section class="page">
        <div class="result-card panel">
          <div class="result-emoji">🎉</div>
          <h2>本组完成</h2>
          <p class="rsub">${esc(session.bookName)} · 用时约 ${mins} 分钟 · 共 ${total} 次判断</p>
          <div class="result-stats">
            <div class="result-stat"><b style="color:var(--green)">${known}</b><span>认识</span></div>
            <div class="result-stat"><b style="color:var(--amber)">${fuzzy}</b><span>模糊</span></div>
            <div class="result-stat"><b style="color:var(--red)">${unknown}</b><span>不认识</span></div>
          </div>
          <div class="actions">
            <button class="btn" id="againBtn">再来一组</button>
            <button class="btn btn-ghost" id="doneQuiz">去做测验</button>
            <button class="btn btn-ghost" id="doneHome">回词库</button>
          </div>
          <p class="hint-block" style="margin-top:22px">「不认识」的词会在 5 分钟后再次到期，明天还会出现在复习队列里。</p>
        </div>
      </section>`;

    $("#againBtn").addEventListener("click", () => {
      const id = session ? session.bookId : (book && book.id);
      session = null;
      startSession(id);
    });
    $("#doneQuiz").addEventListener("click", () => {
      const id = session ? session.bookId : (book && book.id);
      session = null;
      quiz = null;
      quizSetup.bookId = id;
      setView("quiz");
    });
    $("#doneHome").addEventListener("click", () => {
      session = null;
      setView("home");
    });
  }

  function renderSessionEmpty(book) {
    $("#view").innerHTML = `
      <section class="page">
        <div class="study-head">
          <button class="study-back" id="emptyBack">←</button>
          <div class="study-meta"><div class="sm-book">${esc(book.name)}</div><h2>暂无待学内容</h2></div>
          <div></div>
        </div>
        <div class="session-empty panel">
          <div class="big">🌤️</div>
          <h2>今天的任务完成啦</h2>
          <p>「${esc(book.name)}」没有到期复习，今日新词额度也用完了。可以自由加练，或换一本词库。</p>
          <div class="actions">
            <button class="btn" id="freeStudy3">自由加练 20 词</button>
            <button class="btn btn-ghost" id="emptyQuiz">去做测验</button>
            <button class="btn btn-ghost" id="emptyHome">回词库</button>
          </div>
        </div>
      </section>`;
    $("#emptyBack").addEventListener("click", () => { session = null; setView("study"); });
    $("#freeStudy3").addEventListener("click", () => startSession(book.id, { free: true }));
    $("#emptyQuiz").addEventListener("click", () => { session = null; quizSetup.bookId = book.id; quiz = null; setView("quiz"); });
    $("#emptyHome").addEventListener("click", () => { session = null; setView("home"); });
  }

  /* ---------------- 测验 ---------------- */
  function renderQuiz() {
    if (quiz && quiz.phase === "play") return renderQuizPlay();
    if (quiz && quiz.phase === "result") return renderQuizResult();
    return renderQuizSetup();
  }

  function renderQuizSetup() {
    const books = allBooks();
    if (!books.length) {
      $("#view").innerHTML = `<div class="session-empty panel"><div class="big">📚</div><h2>词库还没加载</h2><p>刷新页面再试一次。</p></div>`;
      return;
    }
    if (!quizSetup.bookId || !findBook(quizSetup.bookId)) {
      quizSetup.bookId = state.settings.lastBook || books[0].id;
    }
    const book = findBook(quizSetup.bookId) || books[0];

    $("#view").innerHTML = `
      <section class="page">
        <div class="page-head">
          <p class="eyebrow">QUIZ</p>
          <h1>测一测，记住了吗？</h1>
          <p>四选一快问快答，答错的词会自动进入错题清单。</p>
        </div>
        <div class="setup-card panel">
          <div class="field">
            <div class="field-label">选择词库 <span>${book.words.length} 词</span></div>
            <div class="chip-grid" id="quizBooks">
              ${books.map((b) => `<button class="chip ${b.id === book.id ? "active" : ""}" data-qbook="${esc(b.id)}" style="--c:${esc(b.color || "#ffd60a")}">
                <i class="dot"></i><span>${esc(b.name)}</span><span class="n">${b.words.length}</span>
              </button>`).join("")}
            </div>
          </div>
          <div class="field">
            <div class="field-label">题目数量</div>
            <div class="seg" id="countSeg">
              ${[10, 20, 30].map((n) => `<button data-count="${n}" class="${quizSetup.count === n ? "active" : ""}">${n} 题</button>`).join("")}
            </div>
          </div>
          <div class="field">
            <div class="field-label">出题方向</div>
            <div class="seg" id="dirSeg">
              <button data-dir="en-zh" class="${quizSetup.dir === "en-zh" ? "active" : ""}">英 → 中</button>
              <button data-dir="zh-en" class="${quizSetup.dir === "zh-en" ? "active" : ""}">中 → 英</button>
            </div>
          </div>
          <button class="btn btn-wide" id="startQuiz">开始测验</button>
          <p class="hint-block">题目从所选词库中随机抽取。答错的词会列在结果页，可一键重做。</p>
        </div>
      </section>`;

    $$("#quizBooks [data-qbook]").forEach((chip) => {
      chip.addEventListener("click", () => {
        quizSetup.bookId = chip.dataset.qbook;
        renderQuizSetup();
      });
    });
    $$("#countSeg [data-count]").forEach((btn) => {
      btn.addEventListener("click", () => {
        quizSetup.count = Number(btn.dataset.count);
        renderQuizSetup();
      });
    });
    $$("#dirSeg [data-dir]").forEach((btn) => {
      btn.addEventListener("click", () => {
        quizSetup.dir = btn.dataset.dir;
        renderQuizSetup();
      });
    });
    $("#startQuiz").addEventListener("click", () => startQuiz(book.id));
  }

  function startQuiz(bookId, wordsOverride) {
    const book = findBook(bookId);
    if (!book) return;
    if (book.words.length < 4) {
      toast("词库至少需要 4 个单词才能测验");
      return;
    }
    const pool = (wordsOverride && wordsOverride.length ? wordsOverride : book.words).slice();
    const picked = sample(pool, Math.min(quizSetup.count, pool.length));
    const questions = picked.map((w) => {
      const distractors = sample(
        book.words.filter((x) => x.w !== w.w && x.m !== w.m),
        3
      );
      const options = shuffle([w, ...distractors]);
      return { word: w, options, correct: options.indexOf(w) };
    });
    quiz = {
      phase: "play",
      bookId: book.id,
      bookName: book.name,
      dir: quizSetup.dir,
      questions,
      idx: 0,
      selected: null,
      locked: false,
      answers: [],
    };
    setView("quiz");
  }

  function renderQuizPlay() {
    const q = quiz.questions[quiz.idx];
    if (!q) {
      quiz.phase = "result";
      return renderQuizResult();
    }
    const dir = quiz.dir;
    const prompt = dir === "en-zh" ? q.word.w : q.word.m;
    const correctCount = quiz.answers.filter((a) => a.ok).length;
    const pct = (quiz.idx / quiz.questions.length) * 100;

    $("#view").innerHTML = `
      <section class="page">
        <div class="quiz-top">
          <button class="study-back" id="quizExit" aria-label="退出测验">←</button>
          <div class="qcount"><b>${quiz.idx + 1}</b> / ${quiz.questions.length}</div>
          <div class="quiz-progress"><i style="width:${pct}%"></i></div>
          <div style="font-size:12px;color:var(--muted)" id="quizScore">答对 ${correctCount}</div>
        </div>
        <div class="quiz-card panel">
          <p class="quiz-prompt-label">${dir === "en-zh" ? "选择正确的中文释义" : "选择对应的英文单词"} · ${esc(quiz.bookName)}</p>
          <h2 class="quiz-word ${dir === "zh-en" ? "zh" : ""}">${esc(prompt)}</h2>
          ${dir === "en-zh" && q.word.p ? `<p class="quiz-phon">${esc(q.word.p)}</p>` : ""}
          <div class="options" id="options">
            ${q.options.map((o, i) => `<button class="option" data-opt="${i}">
              <span class="key">${i + 1}</span>
              <span>${esc(dir === "en-zh" ? o.m : o.w)}</span>
            </button>`).join("")}
          </div>
          <div class="quiz-actions">
            <span>数字键 1–4 也可作答</span>
            <span id="quizTip">${quiz.selected === null ? "" : quiz.selected === q.correct ? "回答正确" : "正确答案已标出"}</span>
          </div>
        </div>
      </section>`;

    $("#quizExit").addEventListener("click", () => {
      quiz = null;
      setView("quiz");
    });
    $$("#options .option").forEach((btn) => {
      btn.addEventListener("click", () => chooseOption(Number(btn.dataset.opt)));
    });

    if (quiz.selected !== null) paintQuizAnswer();
  }

  function paintQuizAnswer() {
    const q = quiz.questions[quiz.idx];
    $$("#options .option").forEach((el, i) => {
      el.disabled = true;
      if (i === q.correct) el.classList.add("correct");
      else if (i === quiz.selected) el.classList.add("wrong");
      else el.classList.add("dim");
    });
    const tip = $("#quizTip");
    if (tip) tip.textContent = quiz.selected === q.correct ? "回答正确 ✓" : "正确答案已标出";
    const scoreEl = $("#quizScore");
    if (scoreEl) scoreEl.textContent = `答对 ${quiz.answers.filter((a) => a.ok).length}`;
  }

  function chooseOption(i) {
    if (!quiz || quiz.phase !== "play" || quiz.locked || quiz.selected !== null) return;
    const q = quiz.questions[quiz.idx];
    quiz.selected = i;
    quiz.locked = true;
    const ok = i === q.correct;
    quiz.answers.push({ word: q.word, ok, chosen: i, correct: q.correct });
    paintQuizAnswer();
    const d = todayStats();
    d.quiz = d.quiz || { total: 0, right: 0 };
    d.quiz.total++;
    if (ok) d.quiz.right++;
    saveState();

    setTimeout(() => {
      if (!quiz || quiz.phase !== "play" || view !== "quiz") return;
      quiz.idx++;
      quiz.selected = null;
      quiz.locked = false;
      if (quiz.idx >= quiz.questions.length) quiz.phase = "result";
      render();
    }, ok ? 520 : 900);
  }

  function renderQuizResult() {
    const total = quiz.questions.length;
    const right = quiz.answers.filter((a) => a.ok).length;
    const pct = total ? Math.round((right / total) * 100) : 0;
    const wrong = quiz.answers.filter((a) => !a.ok).map((a) => a.word);
    const bookId = quiz.bookId;

    $("#view").innerHTML = `
      <section class="page">
        <div class="result-card panel" style="max-width:620px">
          <div class="result-emoji">${pct >= 90 ? "🏆" : pct >= 70 ? "💪" : "🌱"}</div>
          <h2>${pct >= 90 ? "接近满分！" : pct >= 70 ? "不错，继续巩固" : "错题就是明天的重点"}</h2>
          <p class="rsub">${esc(quiz.bookName)} · ${quiz.dir === "en-zh" ? "英译中" : "中译英"} · 共 ${total} 题</p>
          <div class="quiz-score-big">${pct}<small>%</small></div>
          <div class="result-stats">
            <div class="result-stat"><b style="color:var(--green)">${right}</b><span>答对</span></div>
            <div class="result-stat"><b style="color:var(--red)">${total - right}</b><span>答错</span></div>
            <div class="result-stat"><b>${total}</b><span>总题数</span></div>
          </div>
          <div class="actions" style="margin-top:22px">
            ${wrong.length ? `<button class="btn" id="retryWrong">重做错题（${wrong.length}）</button>` : `<button class="btn" id="newQuiz">再来一组</button>`}
            <button class="btn btn-ghost" id="quizAgain">重新抽题</button>
            <button class="btn btn-ghost" id="quizHome">回词库</button>
          </div>
          ${wrong.length
            ? `<details class="wrong-details">
                <summary>查看错题清单（${wrong.length}）</summary>
                <div class="wrong-list">
                  ${wrong.map((w) => `<div class="wrong-item"><b>${esc(w.w)}</b><span>${esc(w.m)}</span></div>`).join("")}
                </div>
              </details>`
            : `<p class="hint-block" style="font-size:12.5px;margin-top:22px">全部答对，状态很好。去背一组新词吧。</p>`}
        </div>
      </section>`;

    const retry = $("#retryWrong");
    if (retry) {
      retry.addEventListener("click", () => {
        const words = wrong.slice();
        quiz = null;
        startQuiz(bookId, words);
      });
    }
    $("#newQuiz")?.addEventListener("click", () => { quiz = null; startQuiz(bookId); });
    $("#quizAgain").addEventListener("click", () => { quiz = null; startQuiz(bookId); });
    $("#quizHome").addEventListener("click", () => { quiz = null; setView("home"); });
  }

  /* ---------------- 统计 ---------------- */
  function renderStats() {
    const g = globalStats();
    const t = todayStats();
    const streak = calcStreak();
    const acc = g.right + g.wrong > 0 ? Math.round((g.right / (g.right + g.wrong)) * 100) : 0;
    const seen = Math.max(1, g.seen);
    const pFresh = (g.fresh / seen) * 100;
    const pLearning = pFresh + (g.learning / seen) * 100;
    const masteredPct = g.seen ? Math.round((g.mastered / seen) * 100) : 0;

    /* 最近 70 天热力图，从周一开始对齐 */
    const today = new Date();
    const dow = (today.getDay() + 6) % 7;
    const start = addDays(today, -dow - 63);
    let cells = "";
    for (let i = 0; i < 70; i++) {
      const d = addDays(start, i);
      const k = dayKey(d);
      const v = (state.days[k]?.new || 0) + (state.days[k]?.review || 0) + (state.days[k]?.quiz?.total || 0);
      let lvl = 0;
      if (v > 0) lvl = 1;
      if (v >= 10) lvl = 2;
      if (v >= 25) lvl = 3;
      if (v >= 50) lvl = 4;
      cells += `<i class="l${lvl}" title="${k} · ${v} 词"></i>`;
    }

    const books = allBooks();
    const rows = books.map((b) => {
      const s = bookStats(b);
      const pct = s.total ? Math.round((s.seen / s.total) * 100) : 0;
      return `<div class="bp-row">
        <span class="bp-name">${esc(b.name)}</span>
        <span class="bp-val">${s.mastered} 掌握 · ${pct}%</span>
        <span class="bar"><i style="width:${pct}%;--c:${esc(b.color || "#ffd60a")}"></i></span>
      </div>`;
    }).join("");

    $("#view").innerHTML = `
      <section class="page">
        <div class="page-head">
          <p class="eyebrow">PROGRESS</p>
          <h1>你的学习数据</h1>
          <p>默认只保存在本机；配置云同步后可以跨设备恢复。坚持比强度更重要。</p>
        </div>

        <div class="stat-grid">
          <div class="stat-card">
            <div class="label">🔥 连续学习</div>
            <div class="num">${streak}<small>天</small></div>
            <div class="delta">${streak > 0 ? "别断了，今天也背一点" : "从今天开始"}</div>
          </div>
          <div class="stat-card">
            <div class="label">📅 今日学习</div>
            <div class="num">${t.new + t.review}<small>词</small></div>
            <div class="delta">新词 ${t.new} · 复习 ${t.review}${t.quiz ? ` · 测验 ${t.quiz.total} 题` : ""}</div>
          </div>
          <div class="stat-card">
            <div class="label">🎯 已掌握</div>
            <div class="num">${g.mastered}<small>/ ${g.seen} 学过的词</small></div>
            <div class="delta">掌握率 ${masteredPct}%</div>
          </div>
          <div class="stat-card">
            <div class="label">✅ 复习正确率</div>
            <div class="num">${acc}<small>%</small></div>
            <div class="delta">闪卡判断 ${g.right + g.wrong} 次</div>
          </div>
        </div>

        <div class="stats-cols">
          <div class="stats-panel panel">
            <h3>最近 10 周</h3>
            <p class="p-sub">每个方块代表一天，颜色越亮学得越多。</p>
            <div class="heat-scroll"><div class="heat">${cells}</div></div>
            <div class="heat-legend"><span>少</span><i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i><span>多</span></div>
          </div>
          <div class="stats-panel panel">
            <h3>记忆构成</h3>
            <p class="p-sub">按 Leitner 间隔复习的阶段划分。</p>
            <div class="donut-wrap">
              <div class="donut" style="--p1:${pFresh.toFixed(1)}%;--p2:${pLearning.toFixed(1)}%">
                <div class="donut-center"><b>${masteredPct}%</b><span>已掌握</span></div>
              </div>
              <div class="legend">
                <div><i class="sw" style="background:var(--faint)"></i>待巩固 <b>${g.fresh}</b></div>
                <div><i class="sw" style="background:var(--violet)"></i>学习中 <b>${g.learning}</b></div>
                <div><i class="sw" style="background:var(--accent)"></i>已掌握 <b>${g.mastered}</b></div>
              </div>
            </div>
          </div>
        </div>

        <div class="stats-panel panel" style="margin-top:14px">
          <h3>词库进度</h3>
          <p class="p-sub">按已开始学习的词数计算。</p>
          <div class="book-progress">${rows || "<p class='hint-block'>还没有学习记录。</p>"}</div>
        </div>

        <div class="stats-foot">
          <button class="btn btn-ghost btn-sm" id="statsSettings">学习设置</button>
          <button class="btn btn-ghost btn-sm" id="statsExport">导出数据</button>
        </div>
      </section>`;

    $("#statsSettings").addEventListener("click", openSettings);
    $("#statsExport").addEventListener("click", exportBackup);
  }

  /* ---------------- 设置 / 导入 / 弹窗 ---------------- */
  let afterClose = null;

  function openModal(html, onMount) {
    afterClose = null;
    const root = $("#modalRoot");
    root.innerHTML = `<div class="modal-backdrop" role="dialog" aria-modal="true"><div class="modal">${html}</div></div>`;
    const backdrop = root.firstElementChild;
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal();
    });
    $$("[data-close]", backdrop).forEach((btn) => btn.addEventListener("click", closeModal));
    document.body.style.overflow = "hidden";
    if (onMount) onMount(backdrop);
  }

  function closeModal() {
    $("#modalRoot").innerHTML = "";
    document.body.style.overflow = "";
    const fn = afterClose;
    afterClose = null;
    if (fn) fn();
  }

  function confirmDialog(title, desc, confirmText = "确认") {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKey);
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === "Escape") done(false);
      };
      document.addEventListener("keydown", onKey);
      openModal(`
        <div class="modal-head">
          <div><h3>${esc(title)}</h3><p>${esc(desc)}</p></div>
          <button class="modal-close" data-close aria-label="关闭">✕</button>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost btn-sm" data-close>取消</button>
          <button class="btn btn-sm danger-btn" id="confirmYes">${esc(confirmText)}</button>
        </div>`);
      $("#confirmYes").addEventListener("click", () => {
        closeModal();
        done(true);
      });
      $("#modalRoot .modal-backdrop").addEventListener("click", (e) => {
        if (e.target.classList.contains("modal-backdrop")) done(false);
      });
      $$("[data-close]").forEach((b) => b.addEventListener("click", () => done(false), { once: true }));
    });
  }

  function openSettings() {
    const s = state.settings;
    openModal(`
      <div class="modal-head">
        <div><h3>学习设置</h3><p>偏好保存在本机浏览器</p></div>
        <button class="modal-close" data-close aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">
        <div class="setting-row">
          <div><div class="s-label">每日新词目标</div><div class="s-desc">达到目标后只复习到期词，不再加新词。</div></div>
          <div class="s-control num-stepper">
            <button id="goalMinus" aria-label="减少">−</button>
            <b id="goalVal">${s.dailyNew}</b>
            <button id="goalPlus" aria-label="增加">＋</button>
          </div>
        </div>
        <div class="setting-row">
          <div><div class="s-label">自动发音</div><div class="s-desc">显示英文单词时自动朗读。</div></div>
          <div class="s-control"><button class="switch ${s.autoSpeak ? "on" : ""}" id="autoSpeakSwitch" role="switch" aria-checked="${s.autoSpeak}" aria-label="自动发音"></button></div>
        </div>
        <div class="setting-row">
          <div><div class="s-label">发音口音</div><div class="s-desc">取决于系统安装的语音包。</div></div>
          <div class="s-control">
            <select class="select" id="accentSel">
              <option value="en-US" ${s.accent === "en-US" ? "selected" : ""}>美式英语</option>
              <option value="en-GB" ${s.accent === "en-GB" ? "selected" : ""}>英式英语</option>
            </select>
          </div>
        </div>
        <div class="setting-row">
          <div><div class="s-label">数据备份</div><div class="s-desc">导出进度、统计和设置为一个 JSON 文件。</div></div>
          <div class="s-control" style="display:flex;gap:6px">
            <button class="btn btn-soft btn-sm" id="exportBtn">导出</button>
            <button class="btn btn-ghost btn-sm" id="importBtn">导入</button>
          </div>
        </div>
        <input type="file" id="backupFile" accept="application/json,.json" hidden />
        <div class="setting-row">
          <div><div class="s-label">云同步</div><div class="s-desc" id="cloudDesc">未配置 · 数据只存本机</div></div>
          <div class="s-control"><button class="btn btn-soft btn-sm" id="cloudBtn">设置</button></div>
        </div>
        <div class="setting-row">
          <div><div class="s-label" style="color:var(--red)">清空学习记录</div><div class="s-desc">只清除进度与统计，不影响词库本身。</div></div>
          <div class="s-control"><button class="btn btn-ghost btn-sm danger-btn" id="resetBtn">清空</button></div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-soft btn-sm" data-close>完成</button>
      </div>`);
    const backupInput = $("#backupFile");
    backupInput.addEventListener("change", () => {
      importBackupFile(backupInput.files[0]);
    });
    $("#importBtn").addEventListener("click", () => backupInput.click());
    const cloudDesc = $("#cloudDesc");
    if (window.FlashVocabCloud) {
      cloudDesc.textContent = window.FlashVocabCloud.statusText();
      $("#cloudBtn").addEventListener("click", () => window.FlashVocabCloud.open());
    } else {
      cloudDesc.textContent = "云同步组件未加载";
      $("#cloudBtn").disabled = true;
    }
    afterClose = () => {
      if (view === "home" || view === "stats" || view === "study") render();
    };

    const val = $("#goalVal");
    const syncGoal = (delta) => {
      state.settings.dailyNew = clamp(state.settings.dailyNew + delta, 5, 100);
      val.textContent = state.settings.dailyNew;
      saveState();
    };
    $("#goalMinus").addEventListener("click", () => syncGoal(-5));
    $("#goalPlus").addEventListener("click", () => syncGoal(5));
    $("#autoSpeakSwitch").addEventListener("click", (e) => {
      state.settings.autoSpeak = !state.settings.autoSpeak;
      e.currentTarget.classList.toggle("on", state.settings.autoSpeak);
      e.currentTarget.setAttribute("aria-checked", String(state.settings.autoSpeak));
      saveState();
    });
    $("#accentSel").addEventListener("change", (e) => {
      state.settings.accent = e.target.value;
      saveState();
      speak("vocabulary", true);
    });
    $("#exportBtn").addEventListener("click", exportBackup);
    $("#resetBtn").addEventListener("click", async () => {
      const ok = await confirmDialog("清空学习记录？", "所有学习进度、统计和连续天数都会被清除，无法恢复。", "清空记录");
      if (!ok) {
        openSettings();
        return;
      }
      state.progress = {};
      state.days = {};
      saveState();
      closeModal();
      render();
      toast("学习记录已清空");
    });
  }

  function exportBackup() {
    const payload = {
      app: "FlashVocab",
      version: 1,
      exportedAt: new Date().toISOString(),
      data: state,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flashvocab-backup-${dayKey()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("已导出学习数据");
  }

  function importBackupFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      let obj;
      try {
        obj = JSON.parse(String(reader.result || ""));
      } catch (err) {
        toast("文件不是有效的 JSON");
        return;
      }
      const d = obj && obj.data ? obj.data : obj;
      if (!d || !d.settings || typeof d.progress !== "object") {
        toast("这不是有效的闪词备份文件");
        return;
      }
      const ok = await confirmDialog("导入备份？", "当前进度和统计都会被覆盖，无法撤销。", "导入并覆盖");
      if (!ok) return;
      state = {
        ...defaultState(),
        ...d,
        settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) },
        progress: d.progress || {},
        days: d.days || {},
        custom: Array.isArray(d.custom) ? d.custom : [],
      };
      saveState();
      closeModal();
      applyTheme(state.settings.theme || "dark");
      session = null;
      quiz = null;
      setView("home");
      toast("备份已导入");
    };
    reader.readAsText(file, "utf-8");
  }

  /* ---------------- Toast ---------------- */
  function toast(msg) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2300);
  }

  /* ---------------- 全局事件 ---------------- */
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#f3f5fa" : "#07090f");
  }

  document.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-nav]");
    if (nav) {
      e.preventDefault();
      const v = nav.dataset.nav;
      if (v === "study") {
        if (session && session.idx < session.queue.length) {
          setView("study");
        } else {
          session = null;
          setView("study");
        }
      } else if (v === "quiz") {
        if (!(quiz && quiz.phase === "play")) quiz = null;
        setView("quiz");
      } else {
        setView(v);
      }
    }
  });

  $("#themeBtn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next);
    state.settings.theme = next;
    saveState();
  });
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#userChip").addEventListener("click", () => window.FlashVocabCloud?.open());
  $("#loginChip").addEventListener("click", () => window.FlashVocabCloud?.open());

  document.addEventListener("keydown", (e) => {
    if ($("#modalRoot").children.length) {
      if (e.key === "Escape") closeModal();
      return;
    }
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;

    if (view === "study" && session && session.idx < session.queue.length) {
      if (session.mode === "spell" && session.revealed && e.key === "Enter") {
        e.preventDefault();
        rate(session.spellOk ? "known" : "unknown");
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        if (session.mode !== "spell" && !session.revealed) reveal();
        return;
      }
      if (session.revealed && session.mode !== "spell" && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        rate({ 1: "unknown", 2: "fuzzy", 3: "known" }[e.key]);
      }
      return;
    }
    if (view === "quiz" && quiz && quiz.phase === "play" && ["1", "2", "3", "4"].includes(e.key)) {
      e.preventDefault();
      chooseOption(Number(e.key) - 1);
    }
  });

  /* ---------------- 启动 ---------------- */
  applyTheme(state.settings.theme || "dark");
  setView("home");
  updateUserChip();

  /* 给可选的云同步模块一个最小桥接；不加载 cloud.js 也不影响本地使用 */
  window.FlashVocab = {
    get state() { return state; },
    saveState,
    replaceState(next) {
      state = next;
      saveState(false);
      applyTheme(state.settings.theme || "dark");
      session = null;
      quiz = null;
      setView("home");
    },
    defaultState,
    DEFAULT_SETTINGS,
    toast,
    openModal,
    closeModal,
    confirmDialog,
    setAfterClose(fn) { afterClose = fn; },
    openSettings,
    refreshIdentity() {
      updateUserChip();
      if (view === "home") render();
    },
  };
  window.FlashVocabCloud?.init(window.FlashVocab);
})();
