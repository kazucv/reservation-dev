let verificationMode_ = false;
// Measurement remains available for this page session; hidden by default.
let showTimingPanels_ = false;
function syncTimingPanels_() {
  for (const id of ['startupTimingPanel', 'reservationTimingPanel']) {
    document.getElementById(id)?.classList.toggle('hidden', !showTimingPanels_);
  }
}
document.getElementById('toggleTimingPanels')?.addEventListener('change', event => {
  showTimingPanels_ = verificationMode_ && !!event.target.checked;
  syncTimingPanels_();
});

// Startup measurement v20261029-menu-01. Times start at browser navigation, not the LINE tap.
const startupMeasure_ = { version: '20261029-menu-01', jsStart: performance.now(), ms: {}, completed: false };
async function measureStartupPhase_(name, fn) {
  const start = performance.now();
  try { return await fn(); }
  finally { startupMeasure_.ms[name] = performance.now() - start; }
}
function finishStartupMeasurement_() {
  if (startupMeasure_.completed) return;
  startupMeasure_.completed = true;
  const uiReadyAt = performance.now();
  startupMeasure_.ms.navigationToReady = uiReadyAt;
  startupMeasure_.ms.javascriptToReady = uiReadyAt - startupMeasure_.jsStart;
  // Two animation frames approximate a paint opportunity; this is not proof of screen presentation.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try {
      startupMeasure_.ms.renderOpportunity = performance.now() - uiReadyAt;
      const sec = x => Number.isFinite(x) ? (x / 1000).toFixed(2) + '秒' : '未取得';
      const ms = startupMeasure_.ms;
      const panel = document.createElement('details');
      panel.id = 'startupTimingPanel';
      panel.open = true;
      panel.style.cssText = 'margin:12px 0;padding:10px;background:#edf5ff;border:1px solid #b1cbed;border-radius:8px;font-size:12px;';
      const summary = document.createElement('summary');
      summary.textContent = '起動計測 v' + startupMeasure_.version;
      const pre = document.createElement('pre');
      pre.style.cssText = 'white-space:pre-wrap;font:inherit;user-select:text;';
      pre.textContent = `ページ読込開始→初月の空き情報準備完了:${sec(ms.navigationToReady)}\n画面コード開始まで:${sec(startupMeasure_.jsStart)}\nLIFF初期化:${sec(ms.liffInit)}\nプロフィール取得:${sec(ms.profile)}\n初月の空き枠取得:${sec(ms.initialSlots)}\n描画待ちの目安:${sec(ms.renderOpportunity)}\n※LINEでタップしてからページ読込開始までの時間は含みません。`;
      panel.append(summary, pre);
      document.getElementById('calendar')?.insertAdjacentElement('afterend', panel);
      syncTimingPanels_();
      console.info('STARTUP_TIMING', { version: startupMeasure_.version, jsStart: startupMeasure_.jsStart, ms: { ...ms } });
    } catch (e) { console.warn('Startup measurement display unavailable'); }
  }));
}

console.log("✅ app.js loaded", new Date().toISOString());

// ====== CONFIG ======
const GAS_URL =
  "https://script.google.com/macros/s/AKfycbyMeZw2SvMSzrsTvTlykvSbn2P4pAZy0WEpGuaYDFk1pIZorB-N97uFC9DZYQgQksk/exec";
const LIFF_ID = "2012268088-awR0rQBX";

// ====== DOM ======
const statusEl = document.getElementById("status");

const viewCalendar = document.getElementById("viewCalendar");
const viewSlots = document.getElementById("viewSlots");
const viewForm = document.getElementById("viewForm");
const viewDone = document.getElementById("viewDone");

const viewConfirm = document.getElementById("viewConfirm");
const confirmSummary = document.getElementById("confirmSummary");
const confirmBackBtn = document.getElementById("confirmBackBtn");
const confirmSubmitBtn = document.getElementById("confirmSubmitBtn");

const dateInput = document.getElementById("date");
const calendarRoot = document.getElementById("calendar");

const backToCalendar = document.getElementById("backToCalendar");
const backToSlots = document.getElementById("backToSlots");

const slotCount = document.getElementById("slotCount");
const slotsAM = document.getElementById("slotsAM");
const slotsPM = document.getElementById("slotsPM");

const summary = document.getElementById("summary");
const nameInput = document.getElementById("name");
const telInput = document.getElementById("tel");
const noteInput = document.getElementById("note");
const confirmBtn = document.getElementById("confirmBtn");

// const doneText = document.getElementById("doneText");
const doneSummary = document.getElementById("doneSummary");
const doneToCalendar = document.getElementById("doneToCalendar");
const doneToSlots = document.getElementById("doneToSlots");

const viewList = document.getElementById("viewList");
const listRoot = document.getElementById("listRoot");
const listStatus = document.getElementById("listStatus");

const tabReserve = document.getElementById("tabReserve");
const tabList = document.getElementById("tabList");
const tabSettings = document.getElementById("tabSettings");

const viewSettings = document.getElementById("viewSettings");

const MSG = {
  calendar: "日付を選んでね",
  loadingSlots: "枠を取得中...",
  slots: "時間を選んでね",
  form: "お名前と電話番号を入れてね",
  confirm: "内容を確認してね",
  listLoading: "予約一覧を取得中...",
  settings: "ご案内を表示したよ",
  networkWeak: "通信が不安定みたい。もう一度試してね",
};

const headerGreeting = document.getElementById("headerGreeting");

// ====== state ======
let profile = null;
let fp = null;

// ym -> slots[]
const slotsCache = new Map();
const slotsGenerationByMonth_ = new Map();
const slotsInFlight = new Map(); // ✅ 取得中Promiseを共有する
let slotsReqSeq = 0; // ✅ 月の空き取得の「世代番号」

// slotId/start/end を想定
let selectedDate = null; // "YYYY-MM-DD"
let selectedSlot = null; // slot object

// ====== utils ======
const log = (msg) => {
  console.log(msg);
  if (statusEl) statusEl.textContent = msg; // ←UIにも出す
};

function logInfo(msg) {
  console.log(msg);
  // UIには出さない
}

function logError(msg) {
  console.error(msg);
  if (statusEl) statusEl.textContent = msg; // ←ここだけ出す
}

function clearStatus() {
  if (statusEl) statusEl.textContent = "";
}

function isViewVisible(el) {
  return el && !el.classList.contains("hidden");
}

function fmtMdWithDow(ymd) {
  // "2026-01-05" -> "1月5日(月)"
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd || "";

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);

  const dt = new Date(Date.UTC(y, mo - 1, d));
  const dow = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
  }).format(dt);

  return `${mo}月${d}日(${dow})`;
}

const loadingOverlay = document.getElementById("loadingOverlay");
const loadingTextEl = document.getElementById("loadingText");

function setLoading(isLoading, text = "読み込み中...") {
  if (!loadingOverlay) return;

  if (loadingTextEl) loadingTextEl.textContent = text;

  if (isLoading) {
    if (!document.body.dataset.prevOverflow) {
      document.body.dataset.prevOverflow = document.body.style.overflow || "";
    }
    document.body.style.overflow = "hidden";
  } else {
    document.body.style.overflow = document.body.dataset.prevOverflow || "";
    delete document.body.dataset.prevOverflow;
  }

  loadingOverlay.classList.toggle("hidden", !isLoading);
  loadingOverlay.setAttribute("aria-hidden", String(!isLoading));
}

function isScrollable(el) {
  if (!el) return false;
  const style = getComputedStyle(el);
  const oy = style.overflowY;
  if (!(oy === "auto" || oy === "scroll")) return false;
  return el.scrollHeight > el.clientHeight + 1;
}

function findScrollContainer(startEl) {
  // まず view から親へ辿って「実際にスクロールしてる箱」を探す
  let el = startEl;
  while (el && el !== document.body && el !== document.documentElement) {
    if (isScrollable(el)) return el;
    el = el.parentElement;
  }
  // 最後にドキュメントのスクロール要素へ
  return document.scrollingElement || document.documentElement;
}

function scrollToTopSmart(viewEl) {
  // 1) document 自体（効く環境もある）
  const se = document.scrollingElement || document.documentElement;
  try {
    se.scrollTop = 0;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  } catch {}

  // 2) view の中身に scrollable がある場合も潰す
  try {
    viewEl?.scrollTo?.({ top: 0, left: 0, behavior: "auto" });
    if (viewEl) viewEl.scrollTop = 0;
  } catch {}

  // 3) “本丸” = スクロールコンテナを特定してトップへ
  const sc = findScrollContainer(viewEl);
  try {
    sc.scrollTo?.({ top: 0, left: 0, behavior: "auto" });
    sc.scrollTop = 0;
  } catch {}

  // 4) 念のため：指定クラスや data-scroll の中も潰す（任意）
  viewEl
    ?.querySelectorAll?.("[data-scroll], .scroll, .scroll-area")
    ?.forEach((el) => {
      try {
        el.scrollTop = 0;
        el.scrollTo?.({ top: 0, left: 0, behavior: "auto" });
      } catch {}
    });
}

function setupPullToRefresh({
  gestureEl,
  scroller,
  indicator,
  threshold = 40,
  onRefresh,
}) {
  if (!gestureEl || !scroller) return;

  let startY = 0;
  let pulling = false;
  let triggered = false;
  let busy = false;
  let shown = false;

  const isInteractive = (el) =>
    el?.closest?.(
      "input, textarea, select, button, a, .slot-btn, .danger-btn, .ghost-btn"
    );

  const setIndicator = (state) => {
    if (!indicator) return;

    if (state === "hide") {
      indicator.classList.add("hidden");
      indicator.textContent = "";
      shown = false;
      return;
    }

    if (!shown) {
      indicator.classList.remove("hidden");
      shown = true;
    }

    indicator.textContent =
      state === "pull"
        ? "引っ張って更新"
        : state === "release"
        ? "離して更新"
        : state === "loading"
        ? "更新中…"
        : "";
  };

  setIndicator("hide");

  gestureEl.addEventListener(
    "touchstart",
    (e) => {
      if (busy) return;
      if (isInteractive(e.target)) return;
      if (scroller.scrollTop > 0) return;

      startY = e.touches[0].clientY;
      pulling = true;
      triggered = false;
      setIndicator("hide"); // touchstartでは出さない
    },
    { passive: true }
  );

  gestureEl.addEventListener(
    "touchmove",
    (e) => {
      if (!pulling || busy) return;
      if (scroller.scrollTop > 0) return;

      const dy = e.touches[0].clientY - startY;
      if (dy < 8) return;

      if (dy > threshold) {
        triggered = true;
        setIndicator("release");
      } else {
        triggered = false;
        setIndicator("pull");
      }
    },
    { passive: true }
  );

  gestureEl.addEventListener(
    "touchend",
    async () => {
      if (!pulling || busy) return;
      pulling = false;

      if (!triggered) {
        setIndicator("hide");
        return;
      }

      try {
        busy = true;
        setIndicator("loading");
        await onRefresh?.();
      } catch (e) {
        console.error("❌ pull refresh failed", e);
      } finally {
        busy = false;
        setIndicator("hide");
      }
    },
    { passive: true }
  );
}

// ====== modal (cancel confirm) ======
const modalOverlay = document.getElementById("modalOverlay");
const cancelModal = document.getElementById("cancelModal");
const cancelModalText = document.getElementById("cancelModalText");
const cancelModalMeta = document.getElementById("cancelModalMeta");
const cancelModalYes = document.getElementById("cancelModalYes");
const cancelModalNo = document.getElementById("cancelModalNo");
const cancelModalClose = document.getElementById("cancelModalClose");

let cancelModalBusy = false;

function openCancelModal({ title = "キャンセル確認", message, meta, onYes }) {
  if (!cancelModal || !modalOverlay) {
    // 念のためのフォールバック（URL出るけど最悪）
    const ok = window.confirm(message || "本当にキャンセルしますか？");
    if (ok) onYes?.();
    return;
  }

  // 文言差し替え
  const titleEl = document.getElementById("cancelModalTitle");
  if (titleEl) titleEl.textContent = title;

  if (cancelModalText)
    cancelModalText.textContent = message || "本当にキャンセルしますか？";
  if (cancelModalMeta) cancelModalMeta.textContent = meta || "";

  // 開く
  modalOverlay.classList.remove("hidden");
  cancelModal.classList.remove("hidden");
  modalOverlay.setAttribute("aria-hidden", "false");

  // ボタン状態
  cancelModalBusy = false;
  if (cancelModalYes) {
    cancelModalYes.disabled = false;
    cancelModalYes.textContent = "キャンセルする";
  }

  // 閉じる処理
  const close = () => {
    if (cancelModalBusy) return; // 通信中は閉じさせない方針
    modalOverlay.classList.add("hidden");
    cancelModal.classList.add("hidden");
    modalOverlay.setAttribute("aria-hidden", "true");

    // イベント掃除
    cleanup();
  };

  const yes = async () => {
    if (cancelModalBusy) return;
    cancelModalBusy = true;

    if (cancelModalYes) {
      cancelModalYes.disabled = true;
      cancelModalYes.textContent = "処理中...";
    }
    if (cancelModalNo) cancelModalNo.disabled = true;
    if (cancelModalClose) cancelModalClose.disabled = true;

    try {
      await onYes?.();
      // 成功したら閉じる
      modalOverlay.classList.add("hidden");
      cancelModal.classList.add("hidden");
      modalOverlay.setAttribute("aria-hidden", "true");
    } finally {
      cleanup();
      if (cancelModalNo) cancelModalNo.disabled = false;
      if (cancelModalClose) cancelModalClose.disabled = false;
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") close();
  };

  const cleanup = () => {
    modalOverlay.removeEventListener("click", close);
    cancelModalNo?.removeEventListener("click", close);
    cancelModalClose?.removeEventListener("click", close);
    cancelModalYes?.removeEventListener("click", yes);
    document.removeEventListener("keydown", onKeyDown);
  };

  // イベント登録
  modalOverlay.addEventListener("click", close);
  cancelModalNo?.addEventListener("click", close);
  cancelModalClose?.addEventListener("click", close);
  cancelModalYes?.addEventListener("click", yes);
  document.addEventListener("keydown", onKeyDown);

  // フォーカス
  cancelModalYes?.focus?.();
}

// ====== available days cache ======
let availableDaysSetCache = null;

function invalidateAvailableDaysSet() {
  availableDaysSetCache = null;
}

function getAvailableDaysSet() {
  if (availableDaysSetCache) return availableDaysSetCache;
  availableDaysSetCache = buildAvailableDaysSet();
  return availableDaysSetCache;
}

function setActiveTab(key) {
  tabReserve?.classList.toggle("is-active", key === "reserve");
  tabList?.classList.toggle("is-active", key === "list");
  tabSettings?.classList.toggle("is-active", key === "settings");
}

let viewEpoch_ = 0;
function showView(name) {
  ++viewEpoch_;
  const views = [
    viewCalendar,
    viewMenu,
    viewSlots,
    viewForm,
    viewDone,
    viewList,
    viewConfirm,
    viewSettings,
  ];

  // 全部隠す
  views.forEach((v) => v?.classList.add("hidden"));

  // 表示対象を決める
  let target = null;
  if (name === "calendar") target = viewCalendar;
  if (name === "menu") target = viewMenu;
  if (name === "slots") target = viewSlots;
  if (name === "form") target = viewForm;
  if (name === "confirm") target = viewConfirm;
  if (name === "done") target = viewDone;
  if (name === "list") target = viewList;
  if (name === "settings") target = viewSettings;

  // 表示
  target?.classList.remove("hidden");

  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    if (target) {
      target.scrollTop = 0;
      target.scrollTo?.({ top: 0, left: 0, behavior: "auto" });
    }

    // ✅ PTRのscrollerも必ず0にする（ここ大事）
    const contentEl = document.querySelector("main.content");
    const scrollerEl = findScrollContainer(contentEl);
    if (contentEl) contentEl.scrollTop = 0;
    if (scrollerEl) scrollerEl.scrollTop = 0;
  });
}

function showDone(reserveResult) {
  const rid = reserveResult?.reservationId || "(不明)";

  const slot = reserveResult?.start ? reserveResult : selectedSlot;
  const startHm = slot
    ? hmFromIso(slot.start) || slotIdToStartHm(slot.slotId)
    : "";
  const endHm = slot ? hmFromIso(slot.end) || slotIdToEndHm(slot.slotId) : "";

  if (!doneSummary) {
    log("doneSummary が見つからない…（HTMLのid確認してね）");
    return;
  }

  doneSummary.innerHTML = `
    <div style="font-weight:700; font-size:18px;">${reserveResult?.recovered ? "成立済みの予約を確認しました ✅" : "予約できたよ ✅"}</div>
    <div style="margin-top:8px;" class="sub">予約ID: ${rid}</div>
    <div style="margin-top:8px;" class="sub">日付: ${escapeHtml(reserveResult?.start ? slotIdToYmd(reserveResult.slotId) : (selectedDate || ""))}</div>
    <div style="margin-top:4px;" class="sub">時間: ${startHm} 〜 ${endHm}</div>
    <div style="margin-top:8px;">メニュー：${menuNamesHtml_(reserveResult?.menuNames)}</div>
    ${reserveResult?.notifications?.user === 'failed'
      ? '<p style="margin-top:12px;color:#9a3412;">予約は成立しています。LINE通知を送信できませんでした。予約内容は「予約一覧」で確認できます。</p>'
      : ''}
  `;

  showView("done");
  log(`予約OK: ${rid}`);
}

function formatJpDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);

  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");

  return `${y}年${m}月${day}日 ${hh}:${mm}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ymdFromIsoJa(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const dd = d.getDate();
  return `${y}年${m}月${dd}日`;
}

function toYmd(dateObj) {
  const y = dateObj.getFullYear();
  const m = pad2(dateObj.getMonth() + 1);
  const d = pad2(dateObj.getDate());
  return `${y}-${m}-${d}`;
}

function toYmFromYmd(ymd) {
  // "2026-01-05" -> "202601"
  return String(ymd).replaceAll("-", "").slice(0, 6);
}

function slotIdToYmd(slotId) {
  // "20260105_10:00" -> "2026-01-05"
  const s = String(slotId || "");
  const y = s.slice(0, 4);
  const m = s.slice(4, 6);
  const d = s.slice(6, 8);
  return `${y}-${m}-${d}`;
}

// NOTE: slotIdToHm は "09:00〜11:00" 全体を返すので、UI表示では使わないこと
function slotIdToHm(slotId) {
  // "20260105_10:00" -> "10:00"
  const s = String(slotId || "");
  const idx = s.indexOf("_");
  if (idx === -1) return "";
  return s.slice(idx + 1);
}

function hmFromIso(iso) {
  let value = String(iso || '').trim();
  if (!value) return '';
  // Support the compact date format used by older slot records as well.
  value = value.replace(/^(\d{4})(\d{2})(\d{2})T/, '$1-$2-$3T');
  // If legacy data omits an offset, it represents the application's JST time.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)) value += '+09:00';
  const date = new Date(value);
  if (isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const hour = parts.find(part => part.type === 'hour')?.value;
  const minute = parts.find(part => part.type === 'minute')?.value;
  return hour && minute ? `${hour}:${minute}` : '';
}

function isAM(slot) {
  const hm = hmFromIso(slot.start) || slotIdToStartHm(slot.slotId);
  const h = Number(String(hm || "").slice(0, 2));
  return h < 12;
}

function slotIdToStartHm(slotId) {
  const s = String(slotId || "");
  const idx = s.indexOf("_");
  if (idx === -1) return "";

  const tail = s.slice(idx + 1).replace(/\s/g, ""); // "09:00〜11:00"
  const m = tail.match(/^(\d{2}:\d{2})/);
  return m ? m[1] : "";
}

function slotIdToEndHm(slotId) {
  const s = String(slotId || "");
  const idx = s.indexOf("_");
  if (idx === -1) return "";

  const tail = s.slice(idx + 1).replace(/\s/g, "");
  const parts = tail.split("〜");
  if (parts.length < 2) return "";
  const m = parts[1].match(/^(\d{2}:\d{2})/);
  return m ? m[1] : "";
}

function clearSlotsUI() {
  if (slotsAM) slotsAM.innerHTML = "";
  if (slotsPM) slotsPM.innerHTML = "";
}

function resetFormInputs() {
  for (const field of ['name', 'tel', 'note']) clearReservationFieldError_(field);
  if (nameInput) nameInput.value = "";
  if (telInput) telInput.value = "";
  if (noteInput) noteInput.value = "";
}

function resetNoteOnly() {
  if (noteInput) noteInput.value = "";
}

// ====== network ======
async function postJson(url, payload, timeoutMs = 10000) {
  const measureStart = performance.now();
  let measuredServer = null;
  let measuredOutcome = 'error';
  // ✅ 毎回 accessToken を付ける（userIdは送ってもいいけど信用されない想定）
  if (window.liff && liff.isLoggedIn && liff.isLoggedIn()) {
    payload.accessToken = liff.getAccessToken();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`JSON parse failed: ${text.slice(0, 200)}`);
    }
    measuredServer = data?._timing || null;
    measuredOutcome = data?.ok ? 'ok' : 'api_error';
    return { status: res.status, data };
  } catch (e) {
    // ✅ 中断は「よくある」ので静かに扱う
    if (e?.name === "AbortError") {
      measuredOutcome = 'timeout';
      return { status: 0, data: null, aborted: true };
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (payload.action === 'getSlots') {
      showReservationTiming_(payload.ym, performance.now() - measureStart, measuredServer, measuredOutcome);
    }
  }
}

async function fetchMyReservations() {
  if (!profile?.userId) throw new Error("ユーザー情報が取得できていません");
  const payload = {
    action: "myReservations",
    userId: profile.userId,
    includeCanceled: true,
  };
  const { data } = await postJson(GAS_URL, payload, 10000);

  if (!data?.ok) {
    throw new Error(data?.message || "予約一覧の取得に失敗しました");
  }

  // GAS側は { ok:true, items:[...] } を返してるのでこれでOK
  if (Array.isArray(data.items)) return data.items;

  // 保険（将来返却キーが変わった時用）
  if (Array.isArray(data.reservations)) return data.reservations;

  return [];
}

async function fetchSlotsYm(ym, opts = {}) {
  if (!profile?.userId) throw new Error("ユーザー情報が取得できていません");

  if (!menuSelectionValid_()) throw new Error('先にメニューを選んでください。');
  const menuRequestSignature = JSON.stringify([...selectedMenuIds_].sort()) + ':' + menuSettingsVersion_;
  const force = !!opts.force;

  // force の時はフロントキャッシュを無視
  if (!force) {
    if (slotsCache.has(ym)) {
      const age = Date.now() - (slotsCacheSavedAt_.get(ym) || 0);
      if (age >= 0 && age < 60000) return slotsCache.get(ym);
      slotsCache.delete(ym);
      slotsCacheSavedAt_.delete(ym);
      invalidateAvailableDaysSet();
    }
    if (slotsInFlight.has(ym)) return await slotsInFlight.get(ym);
  } else {
    slotsCache.delete(ym);
    slotsInFlight.delete(ym);
    invalidateAvailableDaysSet();
  }

  const monthGeneration = (slotsGenerationByMonth_.get(ym) || 0) + 1;
  slotsGenerationByMonth_.set(ym, monthGeneration);

  const payload = {
    action: "getSlots",
    menuIds: [...selectedMenuIds_],
    ym,
    force, // ✅ ここが重要
  };

  const p = (async () => {
    const { data, aborted } = await postJson(GAS_URL, payload, 25000);

    if (aborted) return null;
    if (monthGeneration !== slotsGenerationByMonth_.get(ym) || menuRequestSignature !== JSON.stringify([...selectedMenuIds_].sort()) + ':' + menuSettingsVersion_) return null;

    if (!data?.ok || !Array.isArray(data.slots)) {
      throw new Error(data?.message || '空き時間を取得できませんでした。');
    }

    if (data.version !== menuSettingsVersion_) {
      if (isViewVisible(viewCalendar) || isViewVisible(viewSlots)) {
        void openMenuSelection_();
        log('予約設定が変更されました。メニューを選び直してください。');
      }
      return null;
    }
    slotsCache.set(ym, data.slots);
    slotsCacheSavedAt_.set(ym, Date.now());
    invalidateAvailableDaysSet();
    return data.slots;
  })();

  slotsInFlight.set(ym, p);

  try {
    return await p;
  } finally {
    if (slotsInFlight.get(ym) === p) slotsInFlight.delete(ym);
  }
}

async function refreshSlotsYm(ym) {
  // ✅ キャッシュとin-flight両方消して “必ず取り直す”
  slotsCache.delete(ym);
  slotsInFlight.delete(ym);
  invalidateAvailableDaysSet();

  // ✅ 以後のレスポンスを最新世代に寄せる（巻き戻り防止を強める）
  ++slotsReqSeq;

  // ✅ GAS側も強制リフレッシュ（キャッシュ事故を完全に潰す）
  return await fetchSlotsYm(ym, { force: true });
}

// ====== calendar ======
function buildAvailableDaysSet() {
  // キャッシュされてる全 slots から日付集合を作る
  const set = new Set();
  for (const slots of slotsCache.values()) {
    (slots || []).forEach((s) => {
      const ymd = slotIdToYmd(s.slotId);
      set.add(ymd);
    });
  }
  return set;
}

const slotsCacheSavedAt_ = new Map();

// Keep the calendar inert while loading, while allowing navigation and reading.
let calendarLoadingCount_ = 0;
function setCalendarLoading_(loading) {
  calendarLoadingCount_ = Math.max(0, calendarLoadingCount_ + (loading ? 1 : -1));
  const busy = calendarLoadingCount_ > 0;
  const calendar = document.getElementById('calendar');
  const notice = document.getElementById('calendarLoadingNotice');
  if (calendar) {
    calendar.inert = false;
    calendar.setAttribute('aria-busy', String(busy));
    calendar.classList.remove('calendar-is-loading');
  }
  if (notice) notice.classList.toggle('hidden', !busy);
}

function initFlatpickr() {
  if (!window.flatpickr) {
    log("flatpickr が読み込めてない…（CDN確認）");
    return;
  }
  if (!dateInput || !calendarRoot) {
    log("カレンダーDOMが見つからない…（#date / #calendar を確認してね）");
    return;
  }

  const today = new Date();
  const minDate = new Date(today);
  minDate.setHours(0, 0, 0, 0);
  const maxDate = new Date(today);
  maxDate.setMonth(maxDate.getMonth() + 6);

  fp = flatpickr(dateInput, {
    locale: "ja",
    dateFormat: "Y-m-d",
    defaultDate: today,
    minDate,
    maxDate,
    inline: true,
    appendTo: calendarRoot, // ✅ input下じゃなく、このdivに表示
    disableMobile: true,

    onReady: async (selectedDates) => {
      selectedDate = toYmd(selectedDates[0] || today);
      const ym = toYmFromYmd(selectedDate);

      setLoading(false);
      let initialSlotsReady = false;
      setCalendarLoading_(true);
      try {
        log("枠を取得中...");

        const slots = await measureStartupPhase_('initialSlots', () => fetchSlotsYm(ym));

        if (slots === null) {
          log("通信が不安定みたい。もう一度試してね");
          return;
        }

        fp.redraw();
        initialSlotsReady = true;
        if (isViewVisible(viewCalendar)) log("日付を選んでね");
      } catch (e) {
        log(`ERROR: ${e?.message || e}`);
      } finally {
        setCalendarLoading_(false); // Restore calendar input even on errors.
        if (initialSlotsReady) finishStartupMeasurement_();
      }
    },

    onMonthChange: async (selectedDates, dateStr, instance) => {
      const y = instance.currentYear;
      const m = pad2(instance.currentMonth + 1);
      const ym = `${y}${m}`;

      setCalendarLoading_(true);
      try {
        log("枠を取得中...");

        const slots = await fetchSlotsYm(ym);
        if (slots === null) return;

        if (slots.length === 0) {
          if (isViewVisible(viewCalendar)) log("この月は空きがないみたい");
          fp.redraw();
          return;
        }

        fp.redraw();
        if (isViewVisible(viewCalendar)) log("日付を選んでね");
      } catch (e) {
        log(`ERROR: ${e?.message || e}`);
      } finally {
        setCalendarLoading_(false); // Restore calendar input even on errors.
      }
    },

    onChange: async (selectedDates) => {
      const d = selectedDates[0];
      if (!d) return;
      await openSlotsForDate_(toYmd(d));
    },

    onDayCreate: (dObj, dStr, fp, dayElem) => {
      try {
        // ✅ まず毎回リセット（前の月の装飾が残る事故防止）
        dayElem.style.boxShadow = "";
        dayElem.style.borderRadius = "";

        // ✅ グレー表示（前月/次月のはみ出し日）は絶対に装飾しない
        if (
          dayElem.classList.contains("prevMonthDay") ||
          dayElem.classList.contains("nextMonthDay")
        ) {
          return;
        }

        // ✅ 念のため：表示中の月と違う日付は装飾しない
        const viewYm = `${fp.currentYear}${pad2(fp.currentMonth + 1)}`;

        const y = dayElem.dateObj.getFullYear();
        const m = pad2(dayElem.dateObj.getMonth() + 1);
        const d = pad2(dayElem.dateObj.getDate());
        const ymd = `${y}-${m}-${d}`;

        if (toYmFromYmd(ymd) !== viewYm) return;

        const available = getAvailableDaysSet();
        if (available.has(ymd)) {
          dayElem.style.boxShadow = "inset 0 -3px 0 rgba(11,91,211,.35)";
          dayElem.style.borderRadius = "14px";
        }
      } catch {}
    },
  });
}

// Shared by calendar selection and the canceled reservation's rebook button.
async function openSlotsForDate_(ymd, options = {}) {
  selectedDate = ymd;
  selectedSlot = null;
  if (options.syncCalendar) fp?.setDate(ymd, false); // No synthetic onChange request.
  const ym = toYmFromYmd(ymd);
  clearSlotsUI();
  if (slotCount) slotCount.textContent = fmtYmdJaWithDow(ymd);
  if (slotsAM) slotsAM.textContent = '空き時間を確認しています…';
  if (slotsPM) slotsPM.textContent = '空き時間を確認しています…';
  showView('slots');
  const epoch = viewEpoch_;
  const isCurrent = () => epoch === viewEpoch_ && selectedDate === ymd && isViewVisible(viewSlots);
  log('選んだ日の空き時間を確認しています…');
  setCalendarLoading_(true);
  try {
    const slots = options.force ? await refreshSlotsYm(ym) : await fetchSlotsYm(ym);
    if (!isCurrent()) return;
    if (slots === null) throw new Error('Slots unavailable');
    fp?.redraw?.();
    renderSlotsForSelectedDate();
    if (getSlotsForDate(ymd).length === 0) {
      log('この日に予約できる時間はありません。別の日付を選んでください。');
    }
  } catch (e) {
    if (isCurrent()) {
      clearSlotsUI();
      if (slotsAM) slotsAM.textContent = '取得できませんでした';
      if (slotsPM) slotsPM.textContent = '日付選択へ戻って、もう一度お試しください';
      log('空き時間を取得できませんでした。日付選択へ戻ってお試しください。');
    }
    console.error(e);
  } finally { setCalendarLoading_(false); }
}

// ====== slots view ======
function isSlotPastStart(slot) {
  const ymd = slotIdToYmd(slot.slotId);
  const startHm = hmFromIso(slot.start) || slotIdToStartHm(slot.slotId);
  if (!ymd || !startHm) return false;

  const start = new Date(`${ymd}T${startHm}:00+09:00`);
  return start.getTime() <= Date.now();
}

function todayYmdJst() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // "YYYY-MM-DD"
}

function getSlotsForDate(ymd) {
  const ym = toYmFromYmd(ymd);
  const slots = slotsCache.get(ym) || [];
  const list = slots.filter((s) => slotIdToYmd(s.slotId) === ymd);

  // ✅ 今日だけ：開始済みは表示しない
  if (ymd === todayYmdJst()) {
    return list.filter((s) => !isSlotPastStart(s));
  }
  return list;
}

function renderSlotsForSelectedDate() {
  clearSlotsUI();

  const slots = getSlotsForDate(selectedDate);

  // ✅ status に「枠OK + 案内」
  log(`枠OK: ${slots.length}件（時間を選んでね）`);

  // ✅ slotCount に「○月○日（○）」
  if (slotCount) {
    slotCount.textContent = fmtYmdJaWithDow(selectedDate);
  }

  const am = slots.filter((s) => isAM(s));
  const pm = slots.filter((s) => !isAM(s));

  if (am.length === 0) {
    if (slotsAM) slotsAM.innerHTML = `<span class="no-slot">空きなし</span>`;
  }

  if (pm.length === 0) {
    if (slotsPM) slotsPM.innerHTML = `<span class="no-slot">空きなし</span>`;
  }

  const renderBtn = (slot) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slot-btn";

    const startHm = hmFromIso(slot.start) || slotIdToStartHm(slot.slotId);
    const endHm = hmFromIso(slot.end) || slotIdToEndHm(slot.slotId);
    btn.textContent = endHm ? `${startHm} 〜 ${endHm}` : startHm;

    btn.addEventListener("click", () => {
      selectedSlot = slot;
      renderFormSummary();
      showView("form");
      log("お名前と電話番号を入れてね");
    });

    return btn;
  };

  if (slotsAM) am.forEach((s) => slotsAM.appendChild(renderBtn(s)));
  if (slotsPM) pm.forEach((s) => slotsPM.appendChild(renderBtn(s)));
}

// ====== form view ======
function renderFormSummary() {
  const ymd = selectedDate;
  const slot = selectedSlot;
  if (!slot) return;

  const startHm = hmFromIso(slot.start) || slotIdToStartHm(slot.slotId);
  const endHm = hmFromIso(slot.end) || slotIdToEndHm(slot.slotId);
  const d = new Date(ymd);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const dd = d.getDate();

  summary.innerHTML = `
    <div>メニュー：${menuNamesHtml_()}</div>
    <div>日付: ${y}年${m}月${dd}日 / 時間: ${startHm} 〜 ${endHm}</div>
  `;
}

function normalizeTel(raw) { return normalizeReservationPhone_(raw); }

function reservationInputError_(field, message) {
  return { ok: false, code: 'input_invalid', field, message };
}
function normalizeReservationPhone_(raw) {
  return String(raw || '').replace(/[０-９]/g, ch => String(ch.charCodeAt(0) - 0xFF10))
    .replace(/＋/g, '+').replace(/[\s\u3000()（）\-‐‑‒–—―ー−－]/g, '')
    .replace(/^\+81(?=[1-9]\d{8,9}$)/, '0');
}
function validateReservationInput_(body) {
  if (!body || typeof body.name !== 'string' || typeof body.tel !== 'string' ||
      (body.note !== undefined && body.note !== null && typeof body.note !== 'string')) {
    return reservationInputError_('name', '入力内容を確認してください。');
  }
  const name = body.name.trim(), tel = normalizeReservationPhone_(body.tel), note = String(body.note || '').trim();
  if (!name) return reservationInputError_('name', 'お名前を入力してください。');
  if (name.length > 80) return reservationInputError_('name', 'お名前は80文字以内で入力してください。');
  if (/[\u0000-\u001f\u007f]/.test(name)) return reservationInputError_('name', 'お名前に改行や制御文字は使用できません。');
  if (!/^0\d{9,10}$/.test(tel)) return reservationInputError_('tel', '電話番号は0から始まる10〜11桁で入力してください。ハイフン・全角数字も使用できます。');
  if (note.length > 500) return reservationInputError_('note', '備考は500文字以内で入力してください。');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) return reservationInputError_('note', '備考に使用できない制御文字が含まれています。');
  return { ok: true, name, tel, note };
}

function reservationFieldElements_() {
  return { name: nameInput, tel: telInput, note: noteInput };
}
function clearReservationFieldError_(field) {
  const input = reservationFieldElements_()[field];
  input?.removeAttribute('aria-invalid');
  input?.classList.remove('input-error');
  const error = document.getElementById(field + 'Error');
  if (error) { error.textContent = ''; error.classList.add('hidden'); }
}
function setReservationFieldError_(field, message, focus = true) {
  const input = reservationFieldElements_()[field];
  if (!input) return;
  input.setAttribute('aria-invalid', 'true');
  input.classList.add('input-error');
  const error = document.getElementById(field + 'Error');
  if (error) { error.textContent = message; error.classList.remove('hidden'); }
  if (focus) {
    input.focus();
    input.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }
}
function readReservationInput_() {
  for (const field of ['name', 'tel', 'note']) clearReservationFieldError_(field);
  const result = validateReservationInput_({ name: nameInput.value, tel: telInput.value, note: noteInput.value });
  if (!result.ok) {
    setReservationFieldError_(result.field, result.message);
    // Keep the global status concise; the specific message belongs beside the field.
    log('入力内容をご確認ください。');
  } else {
    nameInput.value = result.name; telInput.value = result.tel; noteInput.value = result.note;
  }
  return result;
}
for (const [field, input] of Object.entries(reservationFieldElements_())) {
  input?.addEventListener('input', () => {
    if (input.getAttribute('aria-invalid') !== 'true') return;
    const values = { name: '入力確認', tel: '09000000000', note: '' };
    values[field] = input.value;
    const checked = validateReservationInput_(values);
    if (checked.ok) {
      clearReservationFieldError_(field);
      if (!Object.values(reservationFieldElements_()).some(el => el?.getAttribute('aria-invalid') === 'true')) log('入力を続けてください。');
    } else setReservationFieldError_(field, checked.message, false);
  });
}

// Demo-only, opt-in test: drop one successful create response locally.
let simulateLostReservationReply_ = false;
const simulateLostReplyCheckbox_ = document.getElementById('simulateLostReservationReply');
simulateLostReplyCheckbox_?.addEventListener('change', event => {
  simulateLostReservationReply_ = verificationMode_ && !!event.target.checked && LIFF_ID === '2012268088-awR0rQBX';
});
function consumeLostReplySimulation_() {
  if (!simulateLostReservationReply_ || LIFF_ID !== '2012268088-awR0rQBX') return false;
  simulateLostReservationReply_ = false;
  if (simulateLostReplyCheckbox_) simulateLostReplyCheckbox_.checked = false;
  return true;
}

let pendingOperationMemory_ = null;
let recoveryCheckVisible_ = false;
function syncRecoveryButtons_() {
  for (const id of ['checkReservationStatusBtn', 'checkReservationStatusSettingsBtn']) {
    document.getElementById(id)?.classList.toggle('hidden', !recoveryCheckVisible_);
  }
}
function operationStorageKey_() { return 'reservationPending:v1:' + (profile?.userId || ''); }
function loadPendingOperation_() {
  try { return JSON.parse(sessionStorage.getItem(operationStorageKey_()) || 'null') || pendingOperationMemory_; }
  catch (e) { return pendingOperationMemory_; }
}
function savePendingOperation_(operation) {
  pendingOperationMemory_ = operation;
  if (!operation) { recoveryCheckVisible_ = false; syncRecoveryButtons_(); }
  try {
    if (operation) sessionStorage.setItem(operationStorageKey_(), JSON.stringify(operation));
    else sessionStorage.removeItem(operationStorageKey_());
  } catch (e) { /* Memory fallback for browsers without session storage. */ }
}
async function checkPendingOperation_(operation) {
  return await postJson(GAS_URL, { action: 'reservationRequestStatus', requestId: operation.id }, 10000);
}
async function submitReservationSafely_(payload) {
  let operation = loadPendingOperation_();
  if (!operation) {
    if (!window.crypto?.randomUUID) throw new Error('このブラウザでは予約操作IDを作れません。LINEを更新してお試しください。');
    operation = { id: window.crypto.randomUUID(), createdAt: Date.now() };
    savePendingOperation_(operation);
  }
  let response;
  try { response = await postJson(GAS_URL, { ...payload, requestId: operation.id }, 10000); }
  catch (e) { response = null; }
  if (response?.data?.ok && consumeLostReplySimulation_()) {
    response = null;
    log('検証用に成功応答を未受信として扱い、保存済みの予約を確認します。');
  }
  const uncertain = !response?.data || ['lock_or_internal_error', 'server_error'].includes(response.data.message) || response.data.code === 'request_content_changed';
  if (uncertain) {
    recoveryCheckVisible_ = true;
    syncRecoveryButtons_();
    log('通信結果を確認しています。予約を重ねて送信せず、このままお待ちください。');
    try {
      const status = await checkPendingOperation_(operation);
      if (status.data?.ok && status.data.state === 'reserved') {
        savePendingOperation_(null);
        return { data: status.data.reservation };
      }
      if (status.data?.ok && status.data.state === 'closed') {
        savePendingOperation_(null);
        return { data: { ok: false, message: 'この操作の予約はキャンセル済みです。新しく予約してください。' } };
      }
    } catch (e) { /* Keep operation ID for a safe retry. */ }
    return { data: { ok: false, message: '予約の成立をまだ確認できません。同じ画面で再度確定するか、「予約の成立状況を確認」を押してください。' } };
  }
  // A definitive response (success or rejection before writing) finishes this operation.
  savePendingOperation_(null);
  return response;
}
async function inspectPendingReservation_() {
  if (!profile?.userId) { log('ログイン情報を取得してからお試しください。'); return; }
  const operation = loadPendingOperation_();
  if (!operation) { log('確認待ちの操作はありません。予約一覧で予約内容をご確認ください。'); return; }
  setLoading(true, '予約の成立状況を確認中…');
  try {
    const result = await checkPendingOperation_(operation);
    if (result.data?.ok && result.data.state === 'reserved') {
      savePendingOperation_(null);
      showDone(result.data.reservation);
    } else if (result.data?.ok && result.data.state === 'closed') {
      savePendingOperation_(null);
      log('この操作の予約はキャンセル済みです。予約一覧をご確認ください。');
    } else {
      log('まだ成立を確認できません。処理中の場合もあるため、少し待って再確認してください。');
    }
  } catch (e) { log('確認できませんでした。通信が戻ってから再確認してください。'); }
  finally { setLoading(false); }
}
for (const id of ['checkReservationStatusBtn', 'checkReservationStatusSettingsBtn']) {
  document.getElementById(id)?.addEventListener('click', inspectPendingReservation_);
}

// ====== reserve ======
async function reserveSelected() {
  if (!selectedSlot) return;

  const input = readReservationInput_();
  if (!input.ok) return;
  const { name, tel, note } = input;

  log("予約中...");

  const payload = {
    action: "createReservation",
    slotId: selectedSlot.slotId,
    menuIds: [...selectedMenuIds_],
    settingsVersion: menuSettingsVersion_,
    name,
    tel,
    note,
  };

  const r = await submitReservationSafely_(payload);

  // ✅ 失敗
  if (!r.data?.ok) {
    const msg = String(r.data?.message || "");

    // ここ：埋まってた系は「自動で最新に更新」してから案内（ここは待つ）
    const isAlready =
      msg === "slot_already_reserved" ||
      msg === "slot_already_booked" ||
      msg.includes("already");

    if (isAlready) {
      try {
        log("今ちょうど別の予定が入ったみたい。最新の空きを読み込み直すね…");

        const ym = toYmFromYmd(selectedDate);
        await refreshSlotsYm(ym); // ✅ force=trueで取り直す（ここは await のまま）
        fp?.redraw?.(); // ✅ カレンダーの点も更新

        // slots画面が開いてるなら再描画
        if (
          !document.getElementById("viewSlots")?.classList.contains("hidden")
        ) {
          renderSlotsForSelectedDate();
        }

        log("最新の空きに更新したよ。もう一度時間を選んでね🙂");
      } catch (e) {
        log("更新できなかった…通信が不安定みたい。もう一度試してね");
      }
      return;
    }

    if (r.data?.code === 'input_invalid' && r.data.field) {
      showView('form');
      setReservationFieldError_(r.data.field, r.data.message);
      log('入力内容をご確認ください。');
      return;
    }
    if (['settings_changed', 'menu_invalid'].includes(r.data?.code)) {
      await openMenuSelection_();
      log(r.data.message);
      return;
    }
    // その他のエラー
    log(`予約できませんでした：${msg || "不明なエラー"}`);
    return;
  }

  // ✅ 成功（ここから “体感優先”）
  setLoading(false);
  showDone(r.data);

  // ✅ 備考だけクリア（連続予約でも事故らない）
  resetNoteOnly();

  // ✅ 参照を保持（selectedSlot / fp / selectedDate が後で変わっても安全に）
  const ym = toYmFromYmd(selectedDate);
  const fpRef = fp;

  // ✅ 予約フロー上はここで選択を外してOK
  selectedSlot = null;

  // ✅ ここから先は “裏で最新化” ：awaitしない
  //    1フレーム空けると、done描画→ローディングOFFが先に体感できて気持ちいい
  requestAnimationFrame(() => {
    Promise.resolve().then(async () => {
      try {
        await refreshSlotsYm(ym);
        fpRef?.redraw?.();
      } catch (e) {
        console.warn("bg refreshSlots failed", e);
      }
    });
  });
}

function renderConfirmSummary() {
  if (!confirmSummary) {
    log("confirmSummary が見つからない…（HTMLのid確認してね）");
    return;
  }
  const name = String(nameInput.value || "").trim();
  const tel = normalizeTel(telInput.value);
  const note = String(noteInput.value || "").trim();

  if (!selectedSlot) return;

  const slot = selectedSlot;
  const startHm = hmFromIso(slot.start) || slotIdToStartHm(slot.slotId);
  const endHm = hmFromIso(slot.end) || slotIdToEndHm(slot.slotId);
  const ymdLabel = fmtYmdJaWithDow(selectedDate);

  confirmSummary.innerHTML = `
    <div style="font-weight:700; font-size:16px;">${ymdLabel}</div>
    <div style="margin-top:6px;">時間：${startHm}〜${endHm}</div>
    <div style="margin-top:6px;">メニュー：${menuNamesHtml_()}</div>
    <hr style="opacity:.2; margin:12px 0;" />
    <div>お名前：${escapeHtml(name)}</div>
    <div>電話番号：${escapeHtml(tel)}</div>
    ${
      note
        ? `<div>備考：${escapeHtml(note)}</div>`
        : `<div style="opacity:.6;">備考：なし</div>`
    }
  `;
}

// XSS防止（最低限）
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtYmdJa(ymd) {
  // "2026-01-05" -> "2026年1月5日"
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd || "";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return `${y}年${mo}月${d}日`;
}

function normalizeYmd(ymd) {
  if (ymd instanceof Date && !isNaN(ymd.getTime())) {
    // Date → "YYYY-MM-DD" (JST)
    const y = ymd.getFullYear();
    const m = String(ymd.getMonth() + 1).padStart(2, "0");
    const d = String(ymd.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(ymd || "").replaceAll("/", "-");
}

function fmtYmdJaWithDow(ymd) {
  // "2026-01-05" を "2026年1月5日(月)" に
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd || "";

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);

  // JST固定で曜日出す
  const dt = new Date(Date.UTC(y, mo - 1, d)); // 日付だけをUTCで作る
  const dow = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
  }).format(dt);

  return `${y}年${mo}月${d}日(${dow})`;
}

function ymdFromIso(iso) {
  // ISO -> "YYYY-MM-DD" を返す（JST固定）
  if (!iso) return "";
  const dt = new Date(iso);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", // ★ここが大事
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dt); // "YYYY-MM-DD"
}

function fmtTimeRange(item) {
  // ★ GAS myReservations が返す time（最優先）
  if (item?.time) {
    return String(item.time).replace(/\s/g, "");
  }

  // 保険：start/end or slotId
  const startHm = hmFromIso(item?.start) || slotIdToStartHm(item?.slotId);
  const endHm = hmFromIso(item?.end) || slotIdToEndHm(item?.slotId);
  return endHm ? `${startHm}〜${endHm}` : startHm || "";
}

function pickReservationYmd(it) {
  return (
    it.ymd ||
    (it.date
      ? String(it.date).includes("T")
        ? ymdFromIso(it.date)
        : it.date
      : "") ||
    (it.start ? ymdFromIso(it.start) : "") ||
    (it.slotId ? slotIdToYmd(it.slotId) : "")
  );
}

function setListStatus(msg) {
  if (listStatus) listStatus.textContent = msg || "";
}

function renderReservationList(items) {
  if (!listRoot) return;
  listRoot.innerHTML = "";

  if (!items || items.length === 0) {
    listRoot.innerHTML = `<div style="opacity:.7;">予約はまだありません。</div>`;
    return;
  }

  // ソート：まず日付で（同日内はtimeも見れるなら後で拡張可）
  const sorted = [...items].sort((a, b) =>
    normalizeYmd(pickReservationYmd(a) || "").localeCompare(
      normalizeYmd(pickReservationYmd(b) || "")
    )
  );

  // 見出し
  const headingHtml = (label) => `
    <div class="list-heading">
      ${label}
    </div>
  `;

  // 1件のカード生成（it と card要素を返す）
  const buildCard = (it) => {
    const ymdRaw = pickReservationYmd(it);
    const ymdNorm = normalizeYmd(ymdRaw || "");
    const time = fmtTimeRange(it);

    // ✅ ここが肝：日付 + time で過去判定
    const isPast = isPastByYmdAndTime(ymdNorm, time);

    const ymdLabel = fmtYmdJaWithDow(ymdNorm);

    const rid = it.reservationId || it.id || "";
    const status = it.status || "予約済み";
    const s = String(status || "");

    const isCanceled =
      s.includes("キャンセル") || s.includes("取消") || s.includes("cancel");
    const isDone = s.includes("完了");

    const statusLabel = isCanceled
      ? "⚫️ キャンセル"
      : s.includes("予約")
      ? "🟢 予約済み"
      : isDone
      ? "⚪️ 完了"
      : `⚪️ ${s || "不明"}`;

    // Canceled records start a new booking; elapsed original time must not hide it.
    let actionButtons = "";
    if (isCanceled) {
      const rebookLabel = ymdNorm >= todayYmdJst() ? 'この日で新しく予約' : '新しく予約';
      actionButtons = `
        <button type="button" class="ghost-btn" data-action="rebook">
          ${rebookLabel}
        </button>
      `;
    } else if (!isPast && !isDone) {
      actionButtons = `
        <button type="button" class="danger-btn" data-action="cancel">
          キャンセル
        </button>
      `;
    }

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div style="font-weight:700;">${ymdLabel} / ${time}</div>
      ${it.menuNames?.length ? `<div style="margin-top:8px;">${menuNamesHtml_(it.menuNames)}</div>` : '<div class="hint">メニュー対応前の予約</div>'}
      <div style="margin-top:6px; font-size:13px;">${statusLabel}</div>
      ${
        rid
          ? `<div style="opacity:.5; margin-top:6px; font-size:12px;">予約ID: ${rid}</div>`
          : ""
      }
      <div style="margin-top:3px; display:flex; justify-content:flex-end; gap:8px;">
        ${actionButtons}
      </div>
    `;

    // クリック（ボタンだけ反応）
    card.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) {
        console.log("予約詳細", it);
        return;
      }

      const action = btn.dataset.action;
      const targetRid = it.reservationId || it.id;
      if (!targetRid) return;

      if (action === "cancel") {
        const ymdLabel2 = ymdLabel;
        const time2 = time;
        const targetRid2 = targetRid;

        openCancelModal({
          message: "本当にキャンセルしますか？",
          meta: `${ymdLabel2} / ${time2}\n予約ID: ${targetRid2}`,
          onYes: async () => {
            const ymd2 = normalizeYmd(pickReservationYmd(it) || "");
            const ym2 = toYmFromYmd(ymd2);

            // ✅ ここだけ“確定処理”として待つ（＝ここで成功が確定）
            try {
              setLoading(true, "キャンセルを確定中...");
              setListStatus?.("キャンセル中...");

              const { data } = await postJson(
                GAS_URL,
                {
                  action: "cancelReservation",
                  userId: profile.userId,
                  reservationId: targetRid2,
                },
                10000
              );

              if (!data?.ok) {
                throw new Error(data?.message || "キャンセルに失敗しました");
              }

              // ✅ 成功確定！ここでローディングOFF＆即反映（体感速度重視）
              setLoading(false);
              setListStatus?.("キャンセルしました");

              // いったん“見た目だけ”即更新（すぐに「キャンセル」表示にして安心させる）
              // ※ 手元の it を再描画するだけだと複雑なので、簡易に一覧を取り直さずにステータス表示だけ先に出す
              // ※ 次のバック更新で整合性を取る
              log("キャンセルしたよ");

              // ✅ 残りはバックで（一覧更新・slots更新・カレンダー点更新）
              setTimeout(async () => {
                try {
                  const items2 = await fetchMyReservations();
                  renderReservationList(items2);

                  // slots側も更新（キャンセル枠を空きに戻す）
                  await refreshSlotsYm(ym2);
                  fp?.redraw?.();

                  setListStatus?.("");
                } catch (e) {
                  console.warn("background update failed:", e);
                  // バック更新失敗は致命じゃないので、UIだけ軽く案内
                  setListStatus?.("一覧の更新に失敗しました（再表示してね）");
                }
              }, 0);
            } catch (err) {
              setLoading(false);
              setListStatus?.("キャンセルできませんでした");
              log(`ERROR: ${err?.message || err}`);
            }
          },
        });

        return;
      }

      if (action === "rebook") {
        const ymd2 = normalizeYmd(pickReservationYmd(it) || '');
        await openMenuSelection_(it, /^\d{4}-\d{2}-\d{2}$/.test(ymd2) && ymd2 >= todayYmdJst() ? ymd2 : null);
      }
    });

    // 仕分け用の情報も返す
    const isCurrent = !isPast && !isCanceled && !isDone;

    return { card, isCurrent, isPast };
  };

  // ====== ここから「現在 / 過去」に分けて描画 ======
  const current = [];
  const past = [];

  sorted.forEach((it) => {
    const built = buildCard(it);
    if (built.isCurrent) {
      current.push({ it, card: built.card });
    } else {
      past.push({ it, card: built.card });
    }
  });

  // ===== 並び順調整 =====

  // 現在の予約：日付が近い順（昇順）
  current.sort((a, b) => {
    const da = normalizeYmd(pickReservationYmd(a.it) || "");
    const db = normalizeYmd(pickReservationYmd(b.it) || "");
    return da.localeCompare(db);
  });

  // 過去の予約：新しい順（降順）
  past.sort((a, b) => {
    const da = normalizeYmd(pickReservationYmd(a.it) || "");
    const db = normalizeYmd(pickReservationYmd(b.it) || "");
    return db.localeCompare(da);
  });

  if (current.length) {
    listRoot.insertAdjacentHTML(
      "beforeend",
      headingHtml(`現在の予約（${current.length}）`)
    );
    current.forEach((obj) => listRoot.appendChild(obj.card));
  }

  if (past.length) {
    listRoot.insertAdjacentHTML(
      "beforeend",
      headingHtml(`過去の予約（${past.length}）`)
    );
    past.forEach((obj) => listRoot.appendChild(obj.card));
  }

  // どっちも0の時（理屈上は起きにくいけど保険）
  if (!current.length && !past.length) {
    listRoot.innerHTML = `<div style="opacity:.7;">予約はまだありません。</div>`;
  }
}

function getActiveReservations(items) {
  return items.filter((it) => {
    const ymd = normalizeYmd(pickReservationYmd(it) || "");

    const time = fmtTimeRange(it);
    const isPast = isPastByYmdAndTime(ymd, time);

    const s = String(it.status || "");
    const isCanceled =
      s.includes("キャンセル") || s.includes("取消") || s.includes("cancel");

    // 「未来 or 今日」かつ「キャンセルじゃない」
    return !isPast && !isCanceled;
  });
}

function getPastReservations(items) {
  return items.filter((it) => {
    const ymd = normalizeYmd(pickReservationYmd(it) || "");

    const time = fmtTimeRange(it);
    const isPast = isPastByYmdAndTime(ymd, time);

    const s = String(it.status || "");
    const isCanceled =
      s.includes("キャンセル") || s.includes("取消") || s.includes("cancel");
    const isDone = s.includes("完了");

    return isPast || isCanceled || isDone;
  });
}

async function openListView() {
  showView("list");

  // ✅ 体感UX：ローディングON（一覧取得中）
  setLoading(true, "予約一覧を取得中...");

  // ヘッダー（status）にも表示
  log("予約一覧を取得中...");

  try {
    const items = await fetchMyReservations();
    renderReservationList(items);

    const active = getActiveReservations(items);
    const past = getPastReservations(items);

    // ✅ ヘッダーを件数表示に置き換え
    log(`現在の予約：${active.length}件 / 過去の予約：${past.length}件`);
    setListStatus?.("");
  } catch (e) {
    const msg = e?.message || String(e || "予約一覧の取得に失敗しました");
    logError("予約一覧を取得できませんでした（再読み込みしてね）");

    if (listRoot) {
      listRoot.innerHTML = `
        <div style="opacity:.8; line-height:1.6;">
          予約一覧を取得できませんでした。<br/>
          <span style="opacity:.7; font-size:12px;">${escapeHtml(msg)}</span>
        </div>
        <div style="margin-top:12px; display:flex; gap:8px;">
          <button type="button" class="ghost-btn" id="btnRetryList">再読み込み</button>
          <button type="button" class="ghost-btn" id="btnGoReserve">予約へ戻る</button>
        </div>
      `;

      document
        .getElementById("btnRetryList")
        ?.addEventListener("click", openListView);

      document.getElementById("btnGoReserve")?.addEventListener("click", () => {
        setActiveTab("reserve");
        ensureCalendarView();
      });
    }
  } finally {
    // ✅ 成否に関わらずローディングOFF
    setLoading(false);
  }
}

function isPastByYmdAndTime(ymd, timeRange) {
  if (!ymd) return false;

  const now = Date.now();
  const clean = String(timeRange || "").replace(/\s/g, "");

  // "10:00〜11:00" を想定
  const parts = clean.split("〜");

  let end;

  if (parts.length >= 2) {
    // 終了時刻で判定
    end = new Date(`${ymd}T${parts[1]}:00+09:00`);
  } else {
    // 時間が取れない場合 → その日の終わり
    end = new Date(`${ymd}T23:59:59+09:00`);
  }

  return end.getTime() <= now;
}

// ====== main ======
function ymdToYm(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

async function run() {
  if (!window.liff) {
    log("LIFF SDKが読み込めてない…");
    setLoading(false);
    return;
  }

  try {
    log("1) init LIFF...");
    await measureStartupPhase_('liffInit', () => liff.init({ liffId: LIFF_ID }));

    if (!liff.isLoggedIn()) {
      log("2) login...");
      liff.login();
      return;
    }

    log("3) getting profile...");
    profile = await measureStartupPhase_('profile', () => liff.getProfile());

    if (headerGreeting) {
      headerGreeting.textContent = `こんにちは ${profile.displayName} さん`;
    }

    // UI events
    backToCalendar?.addEventListener("click", () => {
      ensureCalendarView();
    });

    backToSlots?.addEventListener("click", () => {
      showView("slots");
      log(MSG.slots);
    });

    confirmBackBtn?.addEventListener("click", () => {
      showView("form");
      log("修正してね");
    });

    confirmSubmitBtn?.addEventListener("click", async () => {
      // ✅ 先に必須チェック（ここでreturnするならローディング出さない＝チラつかない）
      if (!selectedSlot) {
        log("先に時間を選んでね");
        return;
      }

      const input = readReservationInput_();
      if (!input.ok) return;

      try {
        confirmSubmitBtn.disabled = true;
        confirmSubmitBtn.textContent = "予約しています...";

        setLoading(true, "予約を確定中...");

        await reserveSelected(); // 成功時は reserveSelected 内で showDone まで行く
      } catch (e) {
        log(`ERROR: ${e?.message || e}`);
        console.error(e);
      } finally {
        // ✅ 失敗/例外/途中return等の保険。成功時に既にOFFでもOK
        setLoading(false);

        confirmSubmitBtn.disabled = false;
        confirmSubmitBtn.textContent = "この内容で予約する";
      }
    });

    confirmBtn?.addEventListener("click", () => {
      if (!selectedSlot) {
        log("先に時間を選んでね");
        return;
      }

      const input = readReservationInput_();
      if (!input.ok) return;

      renderConfirmSummary();
      showView("confirm");
      log(MSG.confirm);
    });

    doneToCalendar?.addEventListener("click", () => {
      selectedSlot = null;

      // ✅ 名前とTELは残す / 備考だけ消す
      resetNoteOnly();
      ensureCalendarView();
    });

    doneToSlots?.addEventListener("click", () => {
      if (!menuSelectionValid_()) { void openMenuSelection_(); return; }
      // “同じ日の空き時間を見る”
      showView("slots");
      renderSlotsForSelectedDate();
      log(MSG.slots);
    });

    tabReserve?.addEventListener("click", () => {
      setActiveTab("reserve");
      ensureCalendarView();
      log(MSG.calendar);
    });

    tabList?.addEventListener("click", async () => {
      setActiveTab("list");
      //log(MSG.listLoading);
      await openListView();
    });

    tabSettings?.addEventListener("click", () => {
      setActiveTab("settings");
      showView("settings");
      log(MSG.settings);
    });

    // Start
  } catch (e) {
    log(`ERROR: ${e?.name || "Error"} / ${e?.message || e}`);
    console.error(e);
    return; // ←これ追加！
  }

  // Start
  const params = new URLSearchParams(location.search);
  verificationMode_ = params.get('verify') === '1' && LIFF_ID === '2012268088-awR0rQBX';
  document.getElementById('demoVerificationSettings')?.classList.toggle('hidden', !verificationMode_);
  recoveryCheckVisible_ = !!loadPendingOperation_();
  syncRecoveryButtons_();
  const tab = params.get("tab") || "reserve";

  if (tab === "list") {
    setActiveTab("list");
    await openListView();
  } else if (tab === "settings") {
    setActiveTab("settings");
    showView("settings");
    log(MSG.settings);
    // This entry does not initialize the calendar, so finish its loading state here.
    setLoading(false);
  } else {
    setActiveTab("reserve");
    ensureCalendarView();
  }

  // run() の中：profile取得後に追加
  const contentEl = document.querySelector("main.content");
  const ptrEl = document.getElementById("ptr");

  const scrollerEl =
    findScrollContainer(contentEl) ||
    contentEl ||
    document.scrollingElement ||
    document.documentElement;

  setupPullToRefresh({
    gestureEl: contentEl, // ←触る場所
    scroller: scrollerEl, // ←scrollTop判定する本丸
    indicator: ptrEl,
    onRefresh: async () => {
      if (isViewVisible(viewList)) {
        await openListView();
        return;
      }

      if (!menuSelectionValid_()) return;
      setLoading(true, "空き枠を更新中...");
      try {
        const ymd = selectedDate || todayYmdJst();
        const ym = toYmFromYmd(ymd);

        await refreshSlotsYm(ym);
        fp?.redraw?.();

        if (isViewVisible(viewSlots)) renderSlotsForSelectedDate();
        if (isViewVisible(viewCalendar)) log("日付を選んでね");
      } finally {
        setLoading(false);
      }
    },
  });
}

// Menu selection comes before date/time. No menu or duration is trusted by the server.
const viewMenu = document.getElementById('viewMenu');
let menuCatalog_ = null;
let menuSettingsVersion_ = '';
let selectedMenuIds_ = [];
let menuDateAfterSelection_ = null;
let menuScreenGeneration_ = 0;
function selectedMenuItems_() { return (menuCatalog_?.menus || []).filter(m => selectedMenuIds_.includes(m.id)); }
function menuSelectionValid_() {
  const items = selectedMenuItems_();
  return items.length > 0 && items.length === selectedMenuIds_.length && !(items.length > 1 && items.some(m => m.standalone));
}
function menuNamesHtml_(names) { return escapeHtml((names || selectedMenuItems_().map(m=>m.name)).join(' ＋ ')); }
function resetMenuSlots_() {
  selectedSlot = null;
  slotsCache.clear(); slotsCacheSavedAt_.clear(); slotsInFlight.clear(); slotsGenerationByMonth_.clear();
  invalidateAvailableDaysSet();
}
async function loadMenuCatalog_() {
  const {data} = await postJson(GAS_URL, {action:'getMenuSettings'}, 20000);
  if (!data?.ok || !Array.isArray(data.menus)) throw new Error(data?.message || 'メニューを取得できませんでした。');
  menuCatalog_ = data; menuSettingsVersion_ = data.version;
  selectedMenuIds_ = selectedMenuIds_.filter(id=>data.menus.some(m=>m.id===id));
}
function updateMenuTotal_() {
  const selected = selectedMenuItems_();
  const minutes = selected.reduce((sum,m)=>sum+m.minutes,0);
  document.getElementById('menuTotal').textContent = selected.length
    ? '予約時間の合計：' + minutes + '分'
    : 'メニューを選んでください';
  document.getElementById('menuNext').disabled = !menuSelectionValid_();
}
function renderMenuChoices_() {
  const root = document.getElementById('menuChoices'); root.replaceChildren();
  for (const menu of menuCatalog_.menus) {
    const label=document.createElement('label'); label.className='menu-choice';
    const input=document.createElement('input');input.type='checkbox';input.value=menu.id;input.checked=selectedMenuIds_.includes(menu.id);
    const text=document.createElement('span');
    text.textContent=menu.name+'｜'+menu.minutes+'分'+(menu.actualMinutes!==menu.minutes?'（施術目安'+menu.actualMinutes+'分）':'')+(menu.standalone?'・単独専用':'');
    label.append(input,text);root.append(label);
    input.addEventListener('change',()=>{
      if (input.checked) {
        if (menu.standalone) selectedMenuIds_=[menu.id];
        else selectedMenuIds_=[...new Set([...selectedMenuIds_.filter(id=>!menuCatalog_.menus.find(m=>m.id===id)?.standalone),menu.id])];
      } else selectedMenuIds_=selectedMenuIds_.filter(id=>id!==menu.id);
      root.querySelectorAll('input').forEach(el=>el.checked=selectedMenuIds_.includes(el.value));
      resetMenuSlots_();updateMenuTotal_();
    });
  }
  updateMenuTotal_();
}
async function openMenuSelection_(record = null, day = null) {
  menuDateAfterSelection_=day;
  showView('menu');setActiveTab('reserve');setLoading(false);
  const epoch=viewEpoch_, generation=++menuScreenGeneration_;
  document.getElementById('menuChoices').textContent='メニューを読み込んでいます…';
  document.getElementById('menuNext').disabled=true;
  document.getElementById('menuLoadRetry').classList.add('hidden');
  log('メニューを選んでね');
  try {
    await loadMenuCatalog_();
    if(generation!==menuScreenGeneration_ || epoch!==viewEpoch_)return;
    if(record) {
      selectedMenuIds_=Array.isArray(record.menuIds)?record.menuIds.filter(id=>menuCatalog_.menus.some(m=>m.id===id)):[];
      if(!menuSelectionValid_())selectedMenuIds_=[];
    }
    resetMenuSlots_();renderMenuChoices_();
  } catch(e) {
    if(generation!==menuScreenGeneration_ || epoch!==viewEpoch_)return;
    document.getElementById('menuChoices').textContent='メニューを取得できませんでした。もう一度お試しください。';
    document.getElementById('menuLoadRetry').classList.remove('hidden');log('メニューを取得できませんでした。');
  }
}
document.getElementById('menuLoadRetry')?.addEventListener('click',()=>openMenuSelection_(null,menuDateAfterSelection_));
document.getElementById('changeMenusBtn')?.addEventListener('click',()=>openMenuSelection_());
document.getElementById('menuNext')?.addEventListener('click',async()=>{
  if(!menuSelectionValid_())return;
  document.getElementById('selectedMenusSummary').textContent=selectedMenuItems_().map(m=>m.name).join(' ＋ ')+'｜合計'+selectedMenuItems_().reduce((s,m)=>s+m.minutes,0)+'分';
  const day=menuDateAfterSelection_;menuDateAfterSelection_=null;
  ensureCalendarView();
  if(day && day>=todayYmdJst()) await openSlotsForDate_(day,{force:true,syncCalendar:true});
});

run();

// ====== swipe back (view internal) ======
function ensureCalendarView() {
  if (!menuSelectionValid_()) { void openMenuSelection_(); return; }
  showView("calendar");
  if (!fp) initFlatpickr();
  requestAnimationFrame(() => fp?.redraw?.());
  //log(MSG.calendar);
}

function ensureSlotsView() {
  showView("slots");
  renderSlotsForSelectedDate();
  log(MSG.slots);
}

function ensureFormView() {
  showView("form");
  log(MSG.form);
}

function setupSwipeBack() {
  let sx = 0,
    sy = 0,
    started = false;

  const EDGE = 24;
  const THRESH = 70;
  const VERTICAL_LIMIT = 60;

  const isInteractive = (el) =>
    el?.closest?.(
      "input, textarea, select, button, a, .slot-btn, .danger-btn, .ghost-btn"
    );

  const onPointerDown = (e) => {
    if (e.pointerType === "mouse") return;
    if (isInteractive(e.target)) return;
    if (e.clientX > EDGE) return;

    started = true;
    sx = e.clientX;
    sy = e.clientY;
  };

  const onPointerMove = (e) => {
    if (!started) return;

    const dx = e.clientX - sx;
    const dy = Math.abs(e.clientY - sy);

    if (dy > VERTICAL_LIMIT) {
      started = false;
      return;
    }

    if (dx > THRESH) {
      started = false;

      // confirm → form
      if (viewConfirm && !viewConfirm.classList.contains("hidden")) {
        ensureFormView();
        return;
      }

      // form → slots
      if (viewForm && !viewForm.classList.contains("hidden")) {
        ensureSlotsView();
        return;
      }

      // slots → calendar
      if (viewSlots && !viewSlots.classList.contains("hidden")) {
        ensureCalendarView();
        return;
      }

      // done → calendar
      if (viewDone && !viewDone.classList.contains("hidden")) {
        ensureCalendarView();
        return;
      }

      // list → calendar
      if (viewList && !viewList.classList.contains("hidden")) {
        setActiveTab("reserve");
        ensureCalendarView();
        return;
      }
    }
  };

  const onPointerUp = () => {
    started = false;
  };

  document.addEventListener("pointerdown", onPointerDown, { passive: true });
  document.addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("pointerup", onPointerUp, { passive: true });
}

setupSwipeBack();

// ====== safety net: loading解除 ======
window.addEventListener("unhandledrejection", () => setLoading(false));
window.addEventListener("error", () => setLoading(false));

// Temporary diagnostics for the demo: last eight network requests only.
const reservationTimingRows_ = [];
function showReservationTiming_(ym, elapsed, server, outcome) {
  const ms = server?.ms || {};
  const sec = value => Number.isFinite(value) ? (value / 1000).toFixed(2) + '秒' : '未取得';
  const text = `${ym} / ${outcome} / 計測版:${server?.version || '旧版'} / 月:${server?.slotsCache || '不明'} / 祝日:${server?.holidayCache || '処理なし'} / 営業:${server?.exceptionsCache || '処理なし'}\n通信全体:${sec(elapsed)}　API内部:${sec(ms.apiTotal)}\nAPI外の差分:${sec(Number.isFinite(ms.apiTotal) ? Math.max(0, elapsed - ms.apiTotal) : undefined)}\n本人確認:${sec(ms.authentication)}　APIその他:${sec(ms.apiOther)}\n月キャッシュ読込:${sec(ms.monthCacheRead)}　保存:${sec(ms.monthCacheWrite)}\n営業設定全体:${sec(ms.businessTotal)}\n  キー生成:${sec(ms.businessKey)}　読込:${sec(ms.businessCacheRead)}　保存:${sec(ms.businessCacheWrite)}\n  祝日:${sec(ms.holidays)}　除外日:${sec(ms.excludedDates)}\n予定取得:${sec(ms.busyCalendars)}　空き枠計算:${sec(ms.slotsCompute)}\n空き枠その他:${sec(ms.slotsOther)}\n※営業設定の各内訳は「営業設定全体」に含まれます。`;
  reservationTimingRows_.push(text);
  if (reservationTimingRows_.length > 8) reservationTimingRows_.shift();
  console.info('RESERVATION_TIMING', { ym, elapsedMs: Math.round(elapsed), outcome, server });
  let panel = document.getElementById('reservationTimingPanel');
  if (!panel) {
    panel = document.createElement('details');
    panel.id = 'reservationTimingPanel';
    panel.style.cssText = 'margin:12px 0;padding:10px;background:#fff8db;border:1px solid #dccb89;border-radius:8px;font-size:12px;';
    const summary = document.createElement('summary');
    summary.textContent = '計測結果（デモ検証用・タップで開く）';
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;user-select:text;';
    panel.append(summary, pre);
    const calendar = document.getElementById('calendar');
    if (calendar) calendar.insertAdjacentElement('afterend', panel);
  }
  if (panel) panel.querySelector('pre').textContent = reservationTimingRows_.join('\n\n');
  syncTimingPanels_();
}
