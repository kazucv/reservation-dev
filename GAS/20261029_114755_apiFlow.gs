function validateLineTokenMetadata_(metadata, expectedChannel) {
  if (!metadata || String(metadata.client_id || '') !== expectedChannel) {
    return { ok: false, message: 'この予約アプリ用のログインではありません。デモ用リンクから開き直してください。' };
  }
  const seconds = Number(metadata.expires_in);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { ok: false, message: 'ログインの有効期限が切れています。画面を開き直してください。' };
  }
  if (!String(metadata.scope || '').split(/\s+/).includes('profile')) {
    return { ok: false, message: 'プロフィールの確認権限がありません。ログイン設定を確認してください。' };
  }
  return { ok: true, expiresIn: seconds };
}

function verifyLineAccessToken_(accessToken) {
  const token = String(accessToken || '').trim();
  if (!token) return { ok: false, message: 'ログイン情報がありません。LINEから画面を開き直してください。' };
  const expectedChannel = String(PropertiesService.getScriptProperties().getProperty('LINE_LOGIN_CHANNEL_ID') || '').trim();
  if (!/^\d+$/.test(expectedChannel)) return { ok: false, message: 'LINEログインチャネルIDが未設定です。管理者にご連絡ください。' };
  const cache = CacheService.getScriptCache();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token);
  const tokenHash = digest.map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
  // New namespace excludes the old profile-only cache; bind it to the expected channel.
  const cacheKey = `lineauth:v2:${expectedChannel}:${tokenHash}`;
  const raw = cache.get(cacheKey);
  if (raw) {
    let entry;
    try { entry = JSON.parse(raw); } catch (e) { entry = null; }
    const now = Date.now();
    if (entry && entry.channelId === expectedChannel && typeof entry.userId === 'string' && entry.userId &&
        Number.isFinite(entry.expiresAt) && entry.expiresAt > now &&
        Number.isFinite(entry.validatedAt) && now >= entry.validatedAt && now - entry.validatedAt < 300000) {
      return { ok: true, userId: entry.userId };
    }
  }
  try {
    const startedAt = Date.now();
    const verification = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify?access_token=' + encodeURIComponent(token), {
      method: 'get', muteHttpExceptions: true
    });
    const code = verification.getResponseCode();
    if (code !== 200) return { ok: false, message: code >= 500 || code === 429 ? 'LINEの本人確認が一時的に利用できません。少し待って再度お試しください。' : 'ログイン情報を確認できません。画面を開き直してください。' };
    const metadata = JSON.parse(verification.getContentText() || '{}');
    const checked = validateLineTokenMetadata_(metadata, expectedChannel);
    if (!checked.ok) return checked;
    const expiresAt = startedAt + checked.expiresIn * 1000 - 5000;
    if (expiresAt <= Date.now()) return { ok: false, message: 'ログインの有効期限が近づいています。画面を開き直してください。' };
    const profile = UrlFetchApp.fetch('https://api.line.me/v2/profile', {
      method: 'get', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
    });
    if (profile.getResponseCode() !== 200) return { ok: false, message: 'LINEプロフィールを確認できません。画面を開き直してください。' };
    const data = JSON.parse(profile.getContentText() || '{}');
    const userId = String(data.userId || '').trim();
    if (!userId || expiresAt <= Date.now()) return { ok: false, message: 'ログイン情報を確認できません。画面を開き直してください。' };
    const validatedAt = Date.now();
    const ttl = Math.min(300, Math.floor((expiresAt - validatedAt) / 1000));
    if (ttl > 0) cache.put(cacheKey, JSON.stringify({ userId, channelId: expectedChannel, validatedAt, expiresAt }), ttl);
    return { ok: true, userId };
  } catch (e) {
    // Never log exception text: request URLs can contain access tokens.
    return { ok: false, message: 'LINEの本人確認ができませんでした。通信状態を確認して再度お試しください。' };
  }
}

function withCacheJson_(key, ttlSec, fn) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  const value = fn(); // 重い処理
  cache.put(key, JSON.stringify(value), ttlSec);
  return value;
}

function invalidateCaches_(userId, ymd, idsKey) {
  const cache = CacheService.getScriptCache();

  const uid = String(userId || "").trim();
  if (uid) {
    cache.remove(`myres:${uid}:0`);
    cache.remove(`myres:${uid}:1`);
  }

  const ymdFixed = toYmd_(ymd);
  if (!ymdFixed) return;

  const y = Number(ymdFixed.slice(0, 4));
  const m = Number(ymdFixed.slice(5, 7));
  const d = Number(ymdFixed.slice(8, 10));

  const base = new Date(y, m - 1, d, 0, 0, 0);
  const prev = new Date(y, m - 1, d - 1, 0, 0, 0);
  const next = new Date(y, m - 1, d + 1, 0, 0, 0);

  // ✅ 月 slots キャッシュ（前後月も消す）
  const ymSet = new Set([
    Utilities.formatDate(prev, TZ, "yyyyMM"),
    Utilities.formatDate(base, TZ, "yyyyMM"),
    Utilities.formatDate(next, TZ, "yyyyMM"),
  ]);

  const fixedIdsKey = idsKey || getIdsKey_();
  for (const ym of ymSet) cache.remove(`slots:v4:${ym}:${fixedIdsKey}`);

  // ✅ 日busyキャッシュ（utils.gs 側）
  const ymdCompact = ymdFixed.replaceAll("-", "");
  cache.remove(`busyDay_${ymdCompact}`);

  // ✅ 週busy/週daysキャッシュ（utils.gs 側）
  const weekStart = new Date(base);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // 日曜
  const weekCode = `W_${Utilities.formatDate(weekStart, TZ, "yyyyMMdd")}`;
  cache.remove(`busy_${weekCode}`);
  cache.remove(`days_${weekCode}`);
}

function getIdsKey_() {
  const ids = [CALENDAR_ID].concat(ADDITIONAL_CALENDAR_IDS || []).map(String);
  ids.sort();
  return Utilities.base64EncodeWebSafe(ids.join("|")).slice(0, 16);
}


// ==========================
// LIFF slots (month)
// body: { action:"getSlots", userId, ym:"YYYYMM" }
// return: { ok:true, ym, slots:[{slotId,start,end}] }
// ==========================
function measuredSlotsOriginal_(body) {
  debugLog('🟢 handleGetSlots', { ym: body.ym });
  const ym = String(body.ym || "").trim();
  if (!/^\d{6}$/.test(ym)) return { ok: false, message: "ym_invalid" };

  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(4, 6)); // 1-12

  const idsKey = getIdsKey_();

  const cache = CacheService.getScriptCache();
  const cacheKey = `slots:v4:${ym}:${idsKey}`;

  const force = (body && (
    body.force === true ||
    String(body.force) === "1" ||
    String(body.force).toLowerCase() === "true"
  ));

  if (!force) {
    const cached = measurePhase_("monthCacheRead", () => cache.get(cacheKey));
    if (__measureCtx_) __measureCtx_.slotsCache = cached ? "hit" : "miss";
    if (cached) {
      let entry;
      try { entry = JSON.parse(cached); } catch (e) { entry = null; }
      const age = entry ? Date.now() - entry.savedAt : Infinity;
      if (entry && entry.result && age >= 0 && age < 60000) {
        debugLog('⚡️ slotsキャッシュ命中', { cacheKey });
        return entry.result;
      }
      if (__measureCtx_) __measureCtx_.slotsCache = 'expired';
    }
  } else {
    if (__measureCtx_) __measureCtx_.slotsCache = 'bypass';
    debugLog('🔄 slots強制リフレッシュ', { cacheKey });
    // force のときはキャッシュを読まずに下へ
  }

  // Business settings have their own short cache, independent from live busy data.
  const business = measurePhase_("businessTotal", () => getCachedBusinessDays_(y, m, force));
  const holidayYmdSet = new Set(business.holidays);
  const excludedYmdSet = new Set(business.excluded);

  const slots = [];

  // 月の start/end（JST）
  const monthStart = new Date(y, m - 1, 1, 0, 0, 0);
  const monthEnd = new Date(y, m, 1, 0, 0, 0);

  // ✅ バッファ（前日0:00〜翌日0:00）
  const rangeStart = new Date(monthStart);
  rangeStart.setDate(rangeStart.getDate() - 1);

  const rangeEnd = new Date(monthEnd);
  rangeEnd.setDate(rangeEnd.getDate() + 1);

  // busyAll はこの range で取る
  const busyAll = measurePhase_("busyCalendars", () => getBusySlots(rangeStart, rangeEnd, { force: true }));


  const computeStarted_ = Date.now();

  // ✅ 日ごとに切り出しておく（ymd -> busy[]）
  const busyByYmd = new Map();

  for (const ev of busyAll) {
    // ev が跨ぐ可能性があるので、start日〜end日まで全部に入れる
    const startYmd = Utilities.formatDate(ev.start, TZ, "yyyy-MM-dd");
    const endYmd = Utilities.formatDate(ev.end, TZ, "yyyy-MM-dd");

    // 同日ならそのまま
    if (startYmd === endYmd) {
      if (!busyByYmd.has(startYmd)) busyByYmd.set(startYmd, []);
      busyByYmd.get(startYmd).push(ev);
      continue;
    }

    // 跨ぐ場合：start日とend日、そして間の日も全部入れる（最大でも数日）
    let cur = new Date(ev.start);
    cur.setHours(0, 0, 0, 0);

    const end = new Date(ev.end);
    end.setHours(0, 0, 0, 0);

    while (cur.getTime() <= end.getTime()) {
      const ymd = Utilities.formatDate(cur, TZ, "yyyy-MM-dd");
      if (!busyByYmd.has(ymd)) busyByYmd.set(ymd, []);
      busyByYmd.get(ymd).push(ev);
      cur.setDate(cur.getDate() + 1);
    }
  }

  const daysInMonth = new Date(y, m, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const dateObj = new Date(y, m - 1, d, 0, 0, 0);
    const ymd = Utilities.formatDate(dateObj, TZ, "yyyy-MM-dd");

    if (!isYmdAllowedByMinDaysAhead_(dateObj, MIN_DAYS_AHEAD)) continue;
    if (excludedYmdSet.has(ymd)) continue;
    if (holidayYmdSet.has(ymd)) continue;

    const weekday = dateObj.getDay();
    const rule = WEEKDAY_RULES[weekday] || "ok";
    if (rule === "none") continue;

    let timeRanges = [];
    if (rule === "ok" || rule === "both") {
      timeRanges = [].concat(TIME_SLOTS_AM || [], TIME_SLOTS_PM || []);
    } else if (rule === "am") {
      timeRanges = [].concat(TIME_SLOTS_AM || []);
    } else if (rule === "pm") {
      timeRanges = [].concat(TIME_SLOTS_PM || []);
    } else {
      timeRanges = [].concat(TIME_SLOTS_AM || [], TIME_SLOTS_PM || []);
    }

    // ✅ その日のbusy（なければ空配列）
    const dayBusy = busyByYmd.get(ymd) || [];

    for (const tr of timeRanges) {
      const parsed = parseTimeRangeOnYmd_(ymd, tr);
      if (!parsed) continue;
      const { start, end } = parsed;

      const isBusy = dayBusy.some(ev => start < ev.end && end > ev.start);
      if (isBusy) continue;

      const slotId = ymd.replaceAll("-", "") + "_" + tr; // ✅ "YYYYMMDD_09:00〜11:00"
      slots.push({
        slotId,
        start: Utilities.formatDate(start, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
        end: Utilities.formatDate(end, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      });
    }
  }

  if (__measureCtx_) __measureCtx_.ms.slotsCompute = Date.now() - computeStarted_;
  const result = { ok: true, ym, slots };

  // ✅ 強制更新でもキャッシュは更新してOK（次から速い）
  measurePhase_("monthCacheWrite", () => cache.put(cacheKey, JSON.stringify({ savedAt: Date.now(), result }), 60));
  debugLog('📦 slotsキャッシュ保存', { cacheKey, count: slots.length });

  return result;
}


// ==========================
// helpers
// ==========================

function parseTimeRangeOnYmd_(ymd, timeRange) {
  // timeRange: "10:00〜11:00"
  const s = String(timeRange || "");
  if (!s.includes("〜")) return null;

  const [a, b] = s.split("〜");
  const [sh, sm] = a.split(":");
  const [eh, em] = b.split(":");
  if (!sh || !sm || !eh || !em) return null;

  const start = new Date(`${ymd}T${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}:00+09:00`);
  const end = new Date(`${ymd}T${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}:00+09:00`);
  return { start, end };
}

function isYmdAllowedByMinDaysAhead_(dateObj, minDaysAhead) {
  const n = Number(minDaysAhead || 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const d = new Date(dateObj);
  d.setHours(0, 0, 0, 0);

  const min = new Date(today);
  min.setDate(min.getDate() + n);

  return d.getTime() >= min.getTime();
}


// --- 祝日/除外日（ここは既存関数に差し替えOK） ---
function getHolidaysYmdSet_(year, month1to12) {
  // 既に getHolidays(year, month) があるならそれを使ってOK
  // ここは「無いときでも動く」最低限の空Set
  try {
    if (typeof getHolidays === "function") {
      const holidays = getHolidays(year, month1to12) || [];
      // holidays の中身が "yyyy-MM-dd" / "yyyy/MM/dd" / Date などバラバラでも吸収
      const set = new Set();
      holidays.forEach(v => {
        const ymd = toYmd_(v);
        if (ymd) set.add(ymd);
      });
      return set;
    }
  } catch (e) { }
  return new Set();
}

function getExcludedYmdSet_() {
  // 既に getExcludedDates() があるならそれを使ってOK
  try {
    if (typeof getExcludedDates === "function") {
      const excluded = getExcludedDates() || [];
      const set = new Set();
      excluded.forEach(v => {
        const ymd = toYmd_(v);
        if (ymd) set.add(ymd);
      });
      return set;
    }
  } catch (e) { }
  return new Set();
}

function toYmd_(v) {
  // ✅ overrideオブジェクト対応
  if (v && typeof v === "object" && v.iso) {
    v = v.iso;
  }

  if (v instanceof Date && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, TZ, "yyyy-MM-dd");
  }
  const s = String(v || "").trim();
  if (!s) return "";
  // "yyyy/MM/dd" or "yyyy-MM-dd"
  const m = s.replaceAll("/", "-").match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return "";
  const y = m[1];
  const mo = String(m[2]).padStart(2, "0");
  const d = String(m[3]).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

function measuredApiOriginal_(body) {
  body = body || {};

  // ✅ ここで本人確認して userId を確定
  const v = measurePhase_("authentication", () => verifyLineAccessToken_(body.accessToken));
  if (!v.ok) return { ok: false, message: v.message };

  // ✅ body.userId は信用しない。ここで上書き。
  body.userId = v.userId;

  // ✅ ここ！ actionが確定してる
  debugLog('🟡 apiFlow 通過', {
    action: String(body.action || ''),
    userId: body.userId,
    ym: body.ym,
    slotId: body.slotId,
    reservationId: body.reservationId,
  });


  switch (body.action) {
    case "getSlots":
      return handleGetSlots_(body);
    case "reservationRequestStatus":
      return handleReservationRequestStatus_(body);
    case "createReservation":
      return handleCreateReservation_(body);
    case "myReservations":
      return handleMyReservations_(body);
    case "cancelReservation":
      return handleCancelReservation_(body);
    case "restoreReservation":
      return handleRestoreReservation_(body);
    default:
      return { ok: false, message: "not_implemented_yet" };
  }
}

function handleCancelReservation_(body) {
  debugLog('🟢 handleCancelReservation', { reservationId: body.reservationId });
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);

    const userId = String(body.userId || "").trim();
    const reservationId = String(body.reservationId || "").trim();
    if (!userId) return { ok: false, message: "userId_required" };
    if (!reservationId) return { ok: false, message: "reservationId_required" };

    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    if (!sheet) return { ok: false, message: "sheet_not_found" };

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { ok: false, message: "not_found" };

    const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

    let targetRowIndex = -1;
    let ymd = "";
    let currentStatus = "";
    let eventId = "";

    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      if (String(row[COL.USER_ID]) !== userId) continue;
      if (String(row[COL.RESERVATION_ID]) !== reservationId) continue;

      targetRowIndex = i + 2; // 実シート行
      currentStatus = String(row[COL.STATUS] || "");
      eventId = String(row[COL.EVENT_ID] || ""); // ← 追加

      ymd = toYmd_(row[COL.DATE]);
      break;
    }

    if (targetRowIndex < 0) return { ok: false, message: "not_found" };

    // 冪等：すでにキャンセル済み
    if (currentStatus === STATUS_CANCELED) {
      try { invalidateCaches_(userId, ymd, getIdsKey_()); } catch (e) { console.warn("Reservation saved; cache refresh failed"); }
      return { ok: true, reservationId, alreadyCanceled: true };
    }

    // eventId がない予約は、枠を空けられないので失敗扱いが安全
    //（過去データ移行中だけ例外にしたいなら、ここは ok:true にしてもいい）
    if (!eventId) {
      return { ok: false, message: "eventId_missing" };
    }

    // ✅ カレンダーイベント削除（枠を空ける本体）
    try {
      const cal = CalendarApp.getCalendarById(CALENDAR_ID);
      if (!cal) return { ok: false, message: "calendar_not_found" };

      const ev = cal.getEventById(eventId);
      if (!ev) {
        // すでに消えてる等：ここは「空いてる」のでOKとして進めるのが運用強い
      } else {
        ev.deleteEvent();
      }
    } catch (e) {
      return { ok: false, message: "calendar_delete_failed" };
    }

    // ✅ ステータス更新
    sheet.getRange(targetRowIndex, COL.STATUS + 1).setValue(STATUS_CANCELED);

    const notifications = {};
    notifications.admin = sendReservationNotice_('cancel', reservationId, 'admin', ADMIN_USER_ID,
      `【キャンセル】\n` +
      `予約ID：${reservationId}\n` +
      `userId：${userId}`
    );

    // ✅ キャッシュ無効化
    try { invalidateCaches_(userId, ymd, getIdsKey_()); } catch (e) { console.warn("Reservation saved; cache refresh failed"); }

    try {
      const msg =
        `【キャンセル完了】
予約ID：${reservationId}

またのご予約お待ちしてます。`;
      notifications.user = sendReservationNotice_('cancel', reservationId, 'user', userId, msg);
    } catch (e) {
      try { logLiff_("PUSH_FAIL", { where: "cancelReservation", reservationId, err: String(e) }); } catch { }
    }

    return { ok: true, reservationId, notifications };

  } catch (e) {
    return { ok: false, message: "lock_or_internal_error" };
  } finally {
    try { lock.releaseLock(); } catch (e) { }
  }
}

function handleRestoreReservation_(body) {
  debugLog('🟢 handleRestoreReservation', { reservationId: body.reservationId });

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);

    const userId = String(body.userId || "").trim();
    const reservationId = String(body.reservationId || "").trim();
    if (!userId) return { ok: false, message: "userId_required" };
    if (!reservationId) return { ok: false, message: "reservationId_required" };

    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    if (!sheet) return { ok: false, message: "sheet_not_found" };

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 2) return { ok: false, message: "not_found" };

    const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

    let targetRowIndex = -1;
    let status = "";
    let dateStr = "";     // yyyy/MM/dd or Date
    let timeRange = "";   // "HH:mm〜HH:mm"
    let name = "";
    let tel = "";
    let note = "";

    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      if (String(row[COL.USER_ID] || "") !== userId) continue;
      if (String(row[COL.RESERVATION_ID] || "") !== reservationId) continue;

      targetRowIndex = i + 2;
      status = String(row[COL.STATUS] || "");
      dateStr = row[COL.DATE];
      timeRange = String(row[COL.TIME] || "");
      name = String(row[COL.NAME] || "");
      tel = String(row[COL.TEL] || "");
      note = String(row[COL.NOTE] || "");
      break;
    }

    if (targetRowIndex < 0) return { ok: false, message: "not_found" };

    // すでに予約中なら冪等でOK（復活済み）
    if (status === STATUS_RESERVED) {
      const ymd = toYmd_(dateStr);
      try { invalidateCaches_(userId, ymd, getIdsKey_()); } catch (e) { console.warn("Reservation saved; cache refresh failed"); }
      return { ok: true, reservationId, alreadyReserved: true };
    }

    // キャンセル以外は想定外
    if (status !== STATUS_CANCELED) {
      return { ok: false, message: "status_not_cancelled" };
    }

    const input = validateReservationInput_({ name, tel: tel.replace(/^'/, ''), note });
    if (!input.ok) return input;
    name = input.name; tel = input.tel; note = input.note;
    const ymd = toYmd_(dateStr);
    const parsed = parseSlotId_(`${ymd.replaceAll('-', '')}_${timeRange}`);
    if (!parsed.ok) return parsed;
    const { start, end } = parsed;
    const ruleCheck = validateReservationRules_(parsed, userId, values);
    if (!ruleCheck.ok) return ruleCheck;
    const busy = getVerifiedReservationBusy_(start, end);
    if (busy.length > 0) return { ok: false, message: 'slot_already_reserved' };

    // ② イベント作り直し（メイン）
    const cal = CalendarApp.getCalendarById(CALENDAR_ID);
    if (!cal) return { ok: false, message: "calendar_not_found" };

    const title = `[予約 #${reservationId}] ${name}`;
    const desc = [
      `reservationId: ${reservationId}`,
      `userId: ${userId}`,
      `tel: ${tel}`,
      note ? `note: ${note}` : ""
    ].filter(Boolean).join("\n");

    let event;
    try {
      event = cal.createEvent(title, start, end, { description: desc });
    } catch (e) {
      return { ok: false, message: "calendar_create_failed" };
    }

    // ③ シート復活（STATUS と EVENT_ID を更新）
    sheet.getRange(targetRowIndex, COL.STATUS + 1).setValue(STATUS_RESERVED);
    sheet.getRange(targetRowIndex, COL.EVENT_ID + 1).setValue(event.getId());

    // ④ 通知（管理者）
    const notifications = {};
    notifications.admin = sendReservationNotice_('restore', reservationId, 'admin', ADMIN_USER_ID,
      `【再予約（復活）】\n` +
      `予約ID：${reservationId}\n` +
      `日時：${Utilities.formatDate(start, TZ, "yyyy/MM/dd")} ${timeRange}\n` +
      `お名前：${name}\n` +
      `TEL：${tel}\n` +
      (note ? `備考：${note}\n` : "") +
      `userId：${userId}`
    );

    // ⑤ 通知（本人）
    try {
      const msg =
        `【再予約完了】
予約ID：${reservationId}
日時：${Utilities.formatDate(start, TZ, "yyyy/MM/dd")} ${timeRange}

※このメッセージが控えになります。`;
      notifications.user = sendReservationNotice_('restore', reservationId, 'user', userId, msg);
    } catch (e) {
      try { logLiff_("PUSH_FAIL", { where: "restoreReservation", reservationId, err: String(e) }); } catch { }
    }

    // ⑥ キャッシュ無効化
    try { invalidateCaches_(userId, ymd, getIdsKey_()); } catch (e) { console.warn("Reservation saved; cache refresh failed"); }

    return { ok: true, reservationId, eventId: event.getId(), notifications };

  } catch (e) {
    return { ok: false, message: "lock_or_internal_error" };
  } finally {
    try { lock.releaseLock(); } catch (e) { }
  }
}

function handleCreateReservation_(body) {
  debugLog('🟢 handleCreateReservation', { slotId: body.slotId });
  const userId = String(body.userId || "").trim();
  const input = validateReservationInput_(body);
  if (!input.ok) return input;
  const { name, tel, note } = input;
  body = Object.assign({}, body, { name, tel, note });
  const slotId = String(body.slotId || "").trim();

  if (!userId) return { ok: false, message: "userId_required" };
  if (!slotId) return { ok: false, message: "slotId_required" };
  if (!name) return { ok: false, message: "name_required" };
  if (!tel) return { ok: false, message: "tel_required" };

  const requestId = String(body.requestId || '').trim();
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(requestId)) return { ok: false, code: 'request_id_required', message: '画面を開き直してから予約してください。' };

  // slotId -> start/end
  const parsed = parseSlotId_(slotId);
  if (!parsed.ok) return parsed;

  const { start, end, dateStr, timeLabel } = parsed;

  // ★境界ズレ防止のため 1ms バッファ
  const start2 = new Date(start.getTime() + 1);
  const end2 = new Date(end.getTime() - 1);

  // ★二重予約防止：ロック（slotId単位に寄せたいならDocumentLock + キーキャッシュでもOKだが、まずはScriptLockで堅牢に）
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000); // 10秒まで待つ

    const operationSheet = getOperationSheet_();
    const previous = findReservationOperation_(operationSheet, userId, requestId);
    if (previous) return operationReplay_(previous, body);

    const ruleCheck = validateReservationRules_(parsed, userId);
    if (!ruleCheck.ok) return ruleCheck;

    // Required calendars must all be readable; use fresh data under the lock.
    const busy = getVerifiedReservationBusy_(start, end);
    if (busy.some(ev => start2 < ev.end && end2 > ev.start)) {
      return { ok: false, message: "slot_already_reserved" };
    }

    // 2) 予約を書き込むカレンダー（メイン）
    const cal = CalendarApp.getCalendarById(CALENDAR_ID);
    if (!cal) return { ok: false, message: "calendar_not_found" };

    // 3) 予約番号発行
    const reservationId = generateReservationId_();

    // 4) カレンダー登録
    const title = `[予約 #${reservationId}] ${name}`;
    const desc = [
      `reservationId: ${reservationId}`,
      `userId: ${userId}`,
      `tel: ${tel}`,
      note ? `note: ${note}` : ""
    ].filter(Boolean).join("\n");

    let event;
    try {
      event = cal.createEvent(title, start, end, { description: desc });
    } catch (e) {
      // カレンダー作成に失敗したら即エラー返す（ここでスプシには書かない）
      return { ok: false, message: "calendar_create_failed" };
    }

    // 5) スプレッドシート書き込み
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    if (!sheet) {
      // スプシが無い等で書けない場合は、作ったイベントを巻き戻す（厳密）
      try { event.deleteEvent(); } catch (e) { }
      return { ok: false, message: "sheet_not_found" };
    }

    try {
      appendReservationTextRow_(sheet, [
        reservationId,
        userId,
        dateStr,         // "yyyy/MM/dd"
        timeLabel,       // "HH:mm〜HH:mm"
        name,
        tel,
        note,
        new Date(),
        STATUS_RESERVED,
        event.getId(), // Calendar event ID
        requestId, // K: durable operation ID
      ]);
    } catch (e) {
      // 書き込み失敗 → イベントも消して整合性を保つ（厳密）
      try { event.deleteEvent(); } catch (e2) { }
      return { ok: false, message: "sheet_write_failed" };
    }

    // ✅ 管理者にも通知（予約が“確定”してから送る）
    const notifications = {};
    notifications.admin = sendReservationNotice_('create', reservationId, 'admin', ADMIN_USER_ID,
      `【予約が入りました】\n` +
      `予約ID：${reservationId}\n` +
      `日時：${dateStr} ${timeLabel}\n` +
      `お名前：${name}\n` +
      `TEL：${tel}\n` +
      (note ? `備考：${note}\n` : "") +
      `userId：${userId}`
    );

    // ✅ ここで初めてPush（予約が確定してから）
    try {
      const msg =
        `【ご予約確定】
予約ID：${reservationId}
日時：${dateStr} ${timeLabel}
お名前：${name}

※このメッセージが控えになります。`;
      notifications.user = sendReservationNotice_('create', reservationId, 'user', userId, msg);
    } catch (e) {
      try { logLiff_("PUSH_FAIL", { where: "createReservation", reservationId, err: String(e) }); } catch { }
    }

    // 6) キャッシュ無効化（超大事）
    try { invalidateCaches_(userId, dateStr, getIdsKey_()); } catch (e) { console.warn("Reservation saved; cache refresh failed"); } // dateStr は yyyy/MM/dd でも toYmd_ で正規化される想定

    // 7) ログ
    try {
      logLiff_("RESERVE_OK", { reservationId, slotId, userId });
    } catch (e) { }

    return {
      ok: true,
      notifications,
      reservationId,
      slotId,
      start: start.toISOString(),
      end: end.toISOString(),
      eventId: event.getId()
    };

  } catch (e) {
    // ロック取得失敗や想定外
    return { ok: false, message: "lock_or_internal_error" };
  } finally {
    try { lock.releaseLock(); } catch (e) { }
  }
}


// ==========================
// myReservations ← ★ここに追加
// ==========================
function handleMyReservations_(body) {
  debugLog('🟢 handleMyReservations', {});
  const userId = String(body.userId || "").trim();
  const includeCanceled = !!body.includeCanceled;
  if (!userId) return { ok: false, message: "userId_required" };

  const cache = CacheService.getScriptCache();

  const cacheKey = `myres:${userId}:${includeCanceled ? 1 : 0}`;
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) return { ok: false, message: "sheet_not_found" };

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) {
    const empty = { ok: true, items: [] };
    cache.put(cacheKey, JSON.stringify(empty), 60);
    return empty;
  }

  // ✅ ヘッダ除外して必要範囲だけ
  const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const items = [];

  for (let i = 0; i < values.length; i++) {
    const row = values[i];

    if (String(row[COL.USER_ID]) !== userId) continue;

    const status = row[COL.STATUS];
    if (!includeCanceled && status === STATUS_CANCELED) continue;

    const ymd = toYmd_(row[COL.DATE]); // Dateでも文字でも吸収

    items.push({
      reservationId: String(row[COL.RESERVATION_ID] || ""),
      date: ymd, // ✅ 必ず "yyyy-MM-dd"
      time: String(row[COL.TIME] || ""),
      name: String(row[COL.NAME] || ""),
      tel: String(row[COL.TEL] || ""),
      note: String(row[COL.NOTE] || ""),
      status: String(status || ""),
    });
  }

  const result = { ok: true, items };

  // ✅ 5分キャッシュ（一覧はこれで十分体感変わる）
  cache.put(cacheKey, JSON.stringify(result), 5 * 60);

  return result;
}

/**
 * slotId: "YYYYMMDD_HH:mm〜HH:mm" を start/end に変換する
 * - 枠の長さは固定ではなく、TIME_SLOTS_AM/PM の定義に従う
 * - 例: "20260105_09:00〜11:00" / "20260105_13:30〜15:00"
 */
function parseSlotId_(slotId) {
  const match = String(slotId || '').trim().match(/^(\d{4})(\d{2})(\d{2})_(\d{2}):(\d{2})〜(\d{2}):(\d{2})$/);
  if (!match) return reservationRuleError_('slot_invalid');
  const [, yy, mm, dd, sh, sm, eh, em] = match;
  const y = Number(yy), m = Number(mm), d = Number(dd);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (y < 1000 || y > 9998 || check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return reservationRuleError_('date_invalid');
  }
  if (Number(sh) > 23 || Number(eh) > 23 || Number(sm) > 59 || Number(em) > 59) return reservationRuleError_('slot_invalid');
  const ymd = `${yy}-${mm}-${dd}`;
  const start = new Date(`${ymd}T${sh}:${sm}:00+09:00`);
  const end = new Date(`${ymd}T${eh}:${em}:00+09:00`);
  if (end <= start) return reservationRuleError_('slot_invalid');
  return { ok: true, start, end, ymd, dateStr: `${yy}/${mm}/${dd}`, timeLabel: `${sh}:${sm}〜${eh}:${em}` };
}

function generateReservationId_() {
  // 例: R20251229143012-123
  const ts = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMddHHmmss");
  const rnd = Math.floor(Math.random() * 900) + 100;
  return `R${ts}-${rnd}`;
}

function getLineChannelAccessToken_() {
  return PropertiesService.getScriptProperties().getProperty("LINE_TOKEN") || "";
}

function pushLineText_(toUserId, text) {
  const token = getLineChannelAccessToken_();
  if (!token) throw new Error("LINE_TOKEN is missing");

  const url = "https://api.line.me/v2/bot/message/push";
  const payload = {
    to: String(toUserId || "").trim(),
    messages: [{ type: "text", text: String(text || "") }],
  };

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  if (code !== 200) {
    const error = new Error('LINE push failed');
    error.lineStatus = code;
    throw error;
  }
}

function pushAdminText_(text) {
  if (!ADMIN_USER_ID) return;
  if (!ADMIN_NOTIFY_IMMEDIATE) return; // ✅ スイッチ
  pushLineText_(ADMIN_USER_ID, text);
}


// Temporary timing: no tokens, user IDs, names or reservation contents recorded.
var __measureCtx_ = null;
function measurePhase_(name, fn) {
  const start = Date.now();
  try { return fn(); }
  finally { if (__measureCtx_) __measureCtx_.ms[name] = (__measureCtx_.ms[name] || 0) + Date.now() - start; }
}
function handleGetSlots_(body) {
  return measurePhase_('slotsTotal', () => measuredSlotsOriginal_(body));
}
function handleApiRequest_(body) {
  if (!body || body.action !== 'getSlots') return measuredApiOriginal_(body);
  const start = Date.now();
  __measureCtx_ = { version: 1, ym: /^\d{6}$/.test(String(body.ym || '')) ? String(body.ym) : '', slotsCache: 'not_checked', ms: {} };
  try {
    const result = measuredApiOriginal_(body);
    const timing = __measureCtx_;
    timing.ms.apiTotal = Date.now() - start;
    timing.version = 2;
    timing.ms.slotsOther = Math.max(0, (timing.ms.slotsTotal || 0) - ['businessTotal','busyCalendars','monthCacheRead','monthCacheWrite','slotsCompute'].reduce((sum, key) => sum + (timing.ms[key] || 0), 0));
    timing.ms.apiOther = Math.max(0, timing.ms.apiTotal - (timing.ms.authentication || 0) - (timing.ms.slotsTotal || 0));
    console.log('RESERVATION_TIMING ' + JSON.stringify(timing));
    // Clone: do not add diagnostics to cached business data.
    return Object.assign({}, result, { _timing: timing });
  } finally { __measureCtx_ = null; }
}

// Display-only business data cache (3 minutes). Reservation mutation paths are unchanged.
// Display-only caches: raw holidays 6 hours, business exceptions 3 minutes.
// Reservation mutation paths and forced live busy checks are unchanged.
function getCachedBusinessDays_(year, month, force) {
  const y = Number(year), m = Number(month);
  if (!Number.isInteger(y) || y < 1000 || y > 9998 || !Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error('Invalid business calendar month');
  }
  const cache = CacheService.getScriptCache();
  function keyFor_(source) {
    const digest = measurePhase_('businessKey', () => Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, source));
    return digest.map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('').slice(0, 24);
  }
  function readThrough_(key, ttl, phase, flag, loader) {
    if (!force) {
      const raw = measurePhase_('businessCacheRead', () => cache.get(key));
      if (raw) {
        let entry;
        try { entry = JSON.parse(raw); } catch (e) { entry = null; }
        const age = entry ? Date.now() - entry.savedAt : Infinity;
        if (entry && Array.isArray(entry.value) && age >= 0 && age < ttl * 1000) {
          if (__measureCtx_) __measureCtx_[flag] = 'hit';
          return entry.value;
        }
      }
    }
    if (__measureCtx_) __measureCtx_[flag] = force ? 'bypass' : 'miss';
    const value = measurePhase_(phase, loader);
    measurePhase_('businessCacheWrite', () => cache.put(key, JSON.stringify({ savedAt: Date.now(), value }), ttl));
    return value;
  }
  const monthKey = `${y}-${String(m).padStart(2, '0')}`;
  const holidayKey = `rawHolidays:v1:${monthKey}:${keyFor_(JP_HOLIDAY_CALENDAR_ID)}`;
  const rawHolidays = readThrough_(holidayKey, 21600, 'holidays', 'holidayCache', () => {
    const cal = CalendarApp.getCalendarById(JP_HOLIDAY_CALENDAR_ID);
    if (!cal) throw new Error('Holiday calendar not found');
    const start = new Date(`${monthKey}-01T00:00:00+09:00`);
    const nextYear = m === 12 ? y + 1 : y;
    const nextMonth = m === 12 ? 1 : m + 1;
    const end = new Date(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00+09:00`);
    return [...new Set(cal.getEvents(start, end)
      .map(event => Utilities.formatDate(event.getStartTime(), 'Asia/Tokyo', 'yyyy-MM-dd'))
      .filter(ymd => ymd.startsWith(monthKey + '-')))];
  });
  const exceptionsKey = `businessExceptions:v2:${keyFor_([SHEET_ID, EXCLUDED_SHEET_NAME, EXCLUDE_STATUS_CLOSED, EXCLUDE_STATUS_OPEN].join('|'))}`;
  const exceptions = readThrough_(exceptionsKey, 180, 'excludedDates', 'exceptionsCache', () => {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(EXCLUDED_SHEET_NAME);
    if (!sheet) throw new Error('Business settings sheet not found');
    return sheet.getDataRange().getValues()
      .filter(row => row[0] instanceof Date && !isNaN(row[0].getTime()) &&
        (row[1] === EXCLUDE_STATUS_CLOSED || row[1] === EXCLUDE_STATUS_OPEN))
      .map(row => ({ ymd: toYmd_(row[0]), open: row[1] === EXCLUDE_STATUS_OPEN }));
  });
  const overrides = new Set(exceptions.filter(x => x.open).map(x => x.ymd));
  const excluded = [...new Set(exceptions.filter(x => !x.open).map(x => x.ymd))];
  if (__measureCtx_) __measureCtx_.businessCache = 'split';
  return { holidays: rawHolidays.filter(ymd => !overrides.has(ymd)), excluded };
}

function reservationRuleError_(code) {
  const messages = {
    slot_invalid: '受付対象の時間帯ではありません。日付選択から選び直してください。',
    date_invalid: '日付が正しくありません。日付選択から選び直してください。',
    slot_started: '開始時刻を過ぎています。別の時間を選んでください。',
    day_too_soon: '受付開始前の日付です。別の日付を選んでください。',
    day_too_far: '受付期間外の日付です。カレンダーから選び直してください。',
    day_closed: 'この日は予約を受け付けていません。別の日付を選んでください。',
    reservation_limit: `ご予約はお一人様${MAX_RESERVATIONS}件までです。予約一覧をご確認ください。`,
    rules_unavailable: '営業設定を確認できませんでした。時間をおいて再度お試しください。'
  };
  return { ok: false, code, message: messages[code] || '予約条件を確認できませんでした。' };
}

// Call only while holding the shared reservation script lock.
function validateReservationRules_(parsed, userId, existingRows) {
  if (!parsed || !parsed.ok) return reservationRuleError_('slot_invalid');
  const now = new Date();
  if (parsed.start.getTime() <= now.getTime()) return reservationRuleError_('slot_started');
  const todayKey = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  const today = new Date(`${todayKey}T00:00:00Z`);
  const min = new Date(today);
  min.setUTCDate(min.getUTCDate() + Math.max(0, Number(MIN_DAYS_AHEAD) || 0));
  const max = new Date(today);
  // Match the existing calendar's rolling six-month display window.
  max.setUTCMonth(max.getUTCMonth() + 6);
  const day = new Date(`${parsed.ymd}T00:00:00Z`);
  if (day < min) return reservationRuleError_('day_too_soon');
  if (day > max) return reservationRuleError_('day_too_far');
  const rule = WEEKDAY_RULES[day.getUTCDay()] || 'ok';
  if (rule === 'none') return reservationRuleError_('day_closed');
  let allowed;
  if (rule === 'am') allowed = TIME_SLOTS_AM;
  else if (rule === 'pm') allowed = TIME_SLOTS_PM;
  else if (rule === 'ok' || rule === 'both') allowed = [].concat(TIME_SLOTS_AM || [], TIME_SLOTS_PM || []);
  else return reservationRuleError_('day_closed');
  if (!(allowed || []).includes(parsed.timeLabel)) return reservationRuleError_('slot_invalid');
  try {
    // Force fresh holiday/business reads for the final decision, not display cache.
    const business = getCachedBusinessDays_(day.getUTCFullYear(), day.getUTCMonth() + 1, true);
    if (business.holidays.includes(parsed.ymd) || business.excluded.includes(parsed.ymd)) return reservationRuleError_('day_closed');
    if (Number(MAX_RESERVATIONS) > 0) {
      let rows = existingRows;
      if (!rows) {
        const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
        if (!sheet) throw new Error('Reservation sheet not found');
        rows = sheet.getDataRange().getValues().slice(1);
      }
      // Count active reservations from today onward, matching the existing quota rule.
      const count = rows.filter(row => String(row[COL.USER_ID] || '') === userId &&
        String(row[COL.STATUS] || '') === STATUS_RESERVED && toYmd_(row[COL.DATE]) >= todayKey).length;
      if (count >= Number(MAX_RESERVATIONS)) return reservationRuleError_('reservation_limit');
    }
  } catch (e) { return reservationRuleError_('rules_unavailable'); }
  return { ok: true };
}

function getVerifiedReservationBusy_(start, end) {
  const ids = [...new Set([CALENDAR_ID].concat(ADDITIONAL_CALENDAR_IDS || []).filter(Boolean))];
  const busy = [];
  for (const id of ids) {
    const calendar = CalendarApp.getCalendarById(id);
    if (!calendar) throw new Error('Required calendar unavailable');
    for (const event of calendar.getEvents(start, end)) {
      const evStart = event.getStartTime(), evEnd = event.getEndTime();
      if (start < evEnd && end > evStart) busy.push({ start: evStart, end: evEnd });
    }
  }
  return busy;
}

// K is deliberately checked rather than silently overwriting an existing column.
function getOperationSheet_() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet || String(sheet.getRange(1, 11).getValue()).trim() !== '操作ID') {
    throw new Error('K列の見出しに「操作ID」を設定してください。');
  }
  return sheet;
}
function findReservationOperation_(sheet, userId, requestId) {
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const rows = sheet.getRange(2, 1, last - 1, 11).getValues();
  return rows.find(row => String(row[COL.USER_ID] || '') === userId && String(row[10] || '') === requestId) || null;
}
function reservationOperationResult_(row) {
  const ymd = toYmd_(row[COL.DATE]);
  const parsed = parseSlotId_(`${ymd.replaceAll('-', '')}_${row[COL.TIME]}`);
  if (!parsed.ok) throw new Error('Stored reservation date is invalid');
  return { ok: true, reservationId: String(row[COL.RESERVATION_ID]), slotId: `${ymd.replaceAll('-', '')}_${row[COL.TIME]}`,
    start: parsed.start.toISOString(), end: parsed.end.toISOString(), eventId: String(row[COL.EVENT_ID] || ''), recovered: true };
}
function operationReplay_(row, body) {
  if (String(row[COL.STATUS]) !== STATUS_RESERVED) return { ok: false, code: 'operation_closed', message: 'この操作の予約はキャンセル済みです。新しく予約してください。' };
  const result = reservationOperationResult_(row);
  const same = result.slotId === String(body.slotId || '').trim() &&
    String(row[COL.NAME] || '') === String(body.name || '').trim() &&
    String(row[COL.TEL] || '').replace(/^'/, '') === String(body.tel || '').trim() &&
    String(row[COL.NOTE] || '') === String(body.note || '').trim();
  if (!same) return { ok: false, code: 'request_content_changed', message: '前の予約操作の結果を確認してください。' };
  return result;
}
function handleReservationRequestStatus_(body) {
  const userId = String(body.userId || '').trim(), requestId = String(body.requestId || '').trim();
  if (!userId || !/^[A-Za-z0-9_-]{16,80}$/.test(requestId)) return { ok: false, message: 'request_invalid' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { ok: true, state: 'processing' };
  try {
    const row = findReservationOperation_(getOperationSheet_(), userId, requestId);
    if (!row) return { ok: true, state: 'not_found' };
    if (String(row[COL.STATUS]) !== STATUS_RESERVED) return { ok: true, state: 'closed' };
    return { ok: true, state: 'reserved', reservation: reservationOperationResult_(row) };
  } catch (e) { return { ok: false, message: 'status_unavailable' }; }
  finally { lock.releaseLock(); }
}

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

// Explicit RAW input preserves strings without interpreting formulas or numbers.
// Requires the Google Sheets advanced service (identifier: Sheets).
function appendReservationTextRow_(sheet, values) {
  const rowNumber = sheet.getLastRow() + 1;
  const strings = values.map(value => value instanceof Date
    ? Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss')
    : String(value === null || value === undefined ? '' : value));
  const name = "'" + sheet.getName().replace(/'/g, "''") + "'";
  const range = `${name}!A${rowNumber}:K${rowNumber}`;
  SpreadsheetApp.flush();
  Sheets.Spreadsheets.Values.update({ majorDimension: 'ROWS', values: [strings] }, SHEET_ID, range, { valueInputOption: 'RAW' });
}

// Notification failures are separate from committed reservation data.
function sendReservationNotice_(kind, reservationId, role, to, text) {
  if (role === 'admin' && !ADMIN_NOTIFY_IMMEDIATE) return 'skipped';
  try {
    if (!String(to || '').trim()) {
      const error = new Error('Recipient missing'); error.noticeReason = 'recipient_missing'; throw error;
    }
    if (role === 'user' && consumeDemoNotificationFailure_()) {
      const error = new Error('Simulated notification failure'); error.noticeReason = 'demo_simulation'; throw error;
    }
    pushLineText_(to, text);
    return 'sent';
  } catch (error) {
    const entry = { kind, reservationId, role, httpStatus: Number(error?.lineStatus) || 0,
      reason: ['recipient_missing','demo_simulation'].includes(error?.noticeReason) ? error.noticeReason : 'delivery_error' };
    // Do not log user IDs, token values, names, phone numbers or message contents.
    console.error('RESERVATION_NOTIFICATION_FAILED ' + JSON.stringify(entry));
    recordReservationNotificationFailure_(entry);
    return 'failed';
  }
}
function recordReservationNotificationFailure_(entry) {
  try {
    const book = SpreadsheetApp.openById(LOG_SHEET_ID);
    let sheet = book.getSheetByName('通知エラー');
    if (!sheet) {
      sheet = book.insertSheet('通知エラー');
      sheet.appendRow(['記録日時', '操作種別', '予約ID', '通知先区分', 'HTTPステータス', '理由']);
    }
    sheet.appendRow([Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss'),
      entry.kind, entry.reservationId, entry.role, entry.httpStatus || '', entry.reason]);
  } catch (e) { console.error('RESERVATION_NOTIFICATION_ERROR_LOG_UNAVAILABLE'); }
}
function consumeDemoNotificationFailure_() {
  if (SHEET_ID !== '15JK9k0MkUVjq1znn6GHi8E3L-zyi6H-8MxsfxVCq3xQ' ||
      CALENDAR_ID !== 'b57dcd69b7d8e60267488712be9345f9702c8dafd7bcfc563d9d03f538104b8d@group.calendar.google.com') return false;
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('DEMO_NOTICE_FAILURE_ONCE');
  if (!raw) return false;
  props.deleteProperty('DEMO_NOTICE_FAILURE_ONCE');
  const expiresAt = Number(raw);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}
