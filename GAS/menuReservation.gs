// Menu reservation v1 — shop settings are read afresh for every API request.
// Customer-facing end = service end. Calendar event end = service end + cleanup.
const MENU_SETTING_TABS_ = ['店舗設定', 'メニュー設定', '曜日設定', '日別設定'];
const MENU_HISTORY_HEADERS_ = ['メニューID', 'メニュー名', '予約時間（分）', '片付け（分）', '確保終了', '設定版'];

function menuError_(code, message) { return { ok: false, code, message }; }
function menuAssert_(condition, message) { if (!condition) throw new Error(message); }
function menuInt_(v, min, max, label) {
  menuAssert_(/^\d+$/.test(String(v)), label + 'は整数で設定してください。');
  const n = Number(v); menuAssert_(n >= min && n <= max, label + 'が範囲外です。'); return n;
}
function menuBool_(v, label) {
  const s = String(v).toLowerCase();
  menuAssert_(['true','false'].includes(s), label + 'はTRUE/FALSEで設定してください。');
  return s === 'true';
}
function menuMinute_(v) {
  const m = String(v).match(/^(\d{2}):(\d{2})$/);
  menuAssert_(m && Number(m[1]) <= 23 && Number(m[2]) <= 59, '時刻は09:00のように設定してください。');
  return Number(m[1]) * 60 + Number(m[2]);
}
function menuHm_(n) { return String(Math.floor(n / 60)).padStart(2,'0') + ':' + String(n % 60).padStart(2,'0'); }
function menuDay_(s) {
  s = String(s).replaceAll('/', '-');
  menuAssert_(/^\d{4}-\d{2}-\d{2}$/.test(s), '日別設定の日付はYYYY-MM-DDで設定してください。');
  menuAssert_(new Date(s + 'T00:00:00Z').toISOString().slice(0,10) === s, '日付が正しくありません。'); return s;
}
function menuHash_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value))
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('').slice(0,24);
}
function readMenuSettings_() {
  const result = Sheets.Spreadsheets.Values.batchGet(SHEET_ID, {
    ranges: MENU_SETTING_TABS_.map(name => "'" + name + "'!A:G"), valueRenderOption: 'FORMATTED_VALUE'
  });
  return parseMenuSettings_((result.valueRanges || []).map(range => range.values || []));
}
function parseMenuSettings_(tables) {
  menuAssert_(tables.length === 4, '設定シートを初期化してください。');
  const expected = [
    ['項目','値','説明'], ['ID','メニュー名','施術目安（分）','予約時間（分）','単独のみ','有効'],
    ['曜日番号','曜日','営業','開店','閉店','昼休み開始','昼休み終了'],
    ['日付','営業','開店','閉店','昼休み開始','昼休み終了']
  ];
  tables.forEach((rows,i) => menuAssert_(expected[i].every((v,j) => (rows[0] || [])[j] === v), MENU_SETTING_TABS_[i] + 'の見出しが違います。'));
  const settings = {};
  for (const row of tables[0].slice(1).filter(r => r[0])) {
    menuAssert_(!Object.prototype.hasOwnProperty.call(settings,row[0]), '店舗設定の項目が重複しています。'); settings[row[0]] = row[1];
  }
  const cleanup = menuInt_(settings['片付け時間（分）'],0,180,'片付け時間');
  const outside = menuBool_(settings['閉店後の片付けを許可'],'閉店後の片付け');
  const lunch = menuBool_(settings['昼休みを使用'],'昼休み');
  const lunchCleanup = menuBool_(settings['片付けも昼休みに重ねない'],'昼休みと片付け');
  const open = menuMinute_(settings['開店']), close = menuMinute_(settings['閉店']);
  menuAssert_(open < close, '開店は閉店より前に設定してください。');
  const lunchStart = lunch ? menuMinute_(settings['昼休み開始']) : null;
  const lunchEnd = lunch ? menuMinute_(settings['昼休み終了']) : null;
  if (lunch) menuAssert_(open <= lunchStart && lunchStart < lunchEnd && lunchEnd <= close, '昼休みを営業時間内に設定してください。');
  const menus = [], ids = new Set();
  for (const row of tables[1].slice(1).filter(r => r[0])) {
    const id = String(row[0]), name = String(row[1] || '').trim();
    menuAssert_(/^[a-z][a-z0-9_-]{0,39}$/.test(id) && !ids.has(id), 'メニューIDが不正または重複しています。'); ids.add(id);
    menuAssert_(name && name.length <= 80 && !/[\u0000-\u001f]/.test(name), 'メニュー名を80文字以内で設定してください。');
    const actual = menuInt_(row[2],1,600,'施術目安'), minutes = menuInt_(row[3],30,600,'予約時間');
    menuAssert_(minutes % 30 === 0 && minutes >= actual, '予約時間は施術目安以上・30分単位にしてください。');
    menus.push({ id, name, actualMinutes: actual, minutes, standalone: menuBool_(row[4],'単独のみ'), enabled: menuBool_(row[5],'有効') });
  }
  menuAssert_(menus.length && menus.some(m => m.enabled), '有効なメニューがありません。');
  const week = {}, overrides = {};
  function schedule(row, enabledIndex) {
    const enabled = menuBool_(row[enabledIndex],'営業');
    if (!enabled) return { enabled: false };
    const o = row[enabledIndex+1] ? menuMinute_(row[enabledIndex+1]) : open;
    const c = row[enabledIndex+2] ? menuMinute_(row[enabledIndex+2]) : close;
    menuAssert_(o < c, '営業終了は開始より後にしてください。');
    const a = row[enabledIndex+3], b = row[enabledIndex+4];
    let ls = null, le = null;
    if (a === 'なし' && b === 'なし') { /* explicit no-break override */ }
    else if (!a && !b) { ls = lunchStart; le = lunchEnd; }
    else { ls = menuMinute_(a); le = menuMinute_(b); }
    if (ls !== null) menuAssert_(o <= ls && ls < le && le <= c, '昼休みをその日の営業時間内に設定してください（休憩なしは両欄「なし」）。');
    return { enabled, open: o, close: c, lunchStart: ls, lunchEnd: le };
  }
  for (const row of tables[2].slice(1).filter(r => r[0] !== undefined && r[0] !== '')) {
    const d = menuInt_(row[0],0,6,'曜日番号'); menuAssert_(!Object.prototype.hasOwnProperty.call(week,d),'曜日番号が重複しています。');
    week[d] = schedule(row,2);
  }
  menuAssert_(Object.keys(week).length === 7, '曜日設定は0〜6を各1行設定してください。');
  for (const row of tables[3].slice(1).filter(r => r[0])) {
    const day = menuDay_(row[0]); menuAssert_(!overrides[day], '日別設定の日付が重複しています。'); overrides[day] = schedule(row,1);
  }
  const cfg = { menus, cleanup, outside, lunchCleanup, week, overrides, step: 30 };
  cfg.version = menuHash_(cfg); return cfg;
}
function menuSelection_(cfg, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > cfg.menus.length || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length)
    return menuError_('menu_invalid','メニューを選び直してください。');
  const menus = cfg.menus.filter(m => ids.includes(m.id) && m.enabled);
  if (menus.length !== ids.length) return menuError_('menu_invalid','選択したメニューが変更・停止されています。選び直してください。');
  if (menus.length > 1 && menus.some(m => m.standalone)) return menuError_('menu_invalid','シャンプー・ブローなど単独専用のメニューは、ほかのメニューと組み合わせられません。');
  const duration = menus.reduce((n,m) => n+m.minutes,0);
  if (duration > 720) return menuError_('menu_invalid','合計時間が長すぎます。メニューを選び直してください。');
  return { ok: true, ids: menus.map(m => m.id).sort(), names: menus.map(m => m.name), duration, cleanup: cfg.cleanup };
}
function menuSchedule_(cfg, day) { return cfg.overrides[day] || cfg.week[new Date(day+'T00:00:00Z').getUTCDay()]; }
function menuFits_(cfg, schedule, start, duration) {
  if (!schedule || !schedule.enabled || start % 30 !== 0) return false;
  const end = start+duration, occupiedEnd = end+cfg.cleanup;
  if (start < schedule.open || end > schedule.close || occupiedEnd >= 1440) return false;
  if (!cfg.outside && occupiedEnd > schedule.close) return false;
  const breakEnd = cfg.lunchCleanup ? occupiedEnd : end;
  return schedule.lunchStart === null || !(start < schedule.lunchEnd && breakEnd > schedule.lunchStart);
}
function menuDateAllowed_(day, now) {
  const today = Utilities.formatDate(now, 'Asia/Tokyo','yyyy-MM-dd');
  const min = new Date(today+'T00:00:00Z'); min.setUTCDate(min.getUTCDate()+Math.max(0,Number(MIN_DAYS_AHEAD)||0));
  const max = new Date(today+'T00:00:00Z'); max.setUTCMonth(max.getUTCMonth()+6);
  const d = new Date(day+'T00:00:00Z'); return d >= min && d <= max;
}
function menuCandidate_(cfg, selection, day, minute) {
  const start = new Date(day+'T'+menuHm_(minute)+':00+09:00');
  const end = new Date(start.getTime()+selection.duration*60000);
  const blockedEnd = new Date(end.getTime()+selection.cleanup*60000);
  return { slotId: day.replaceAll('-','')+'_'+menuHm_(minute)+'〜'+menuHm_(minute+selection.duration), start, end, blockedEnd };
}
function menuSettingsApi_() {
  try {
    const cfg = readMenuSettings_();
    return { ok: true, version: cfg.version, menus: cfg.menus.filter(m=>m.enabled), cleanupMinutes: cfg.cleanup, stepMinutes: cfg.step };
  } catch(e) { return menuError_('settings_invalid', '予約設定を確認できません。管理者にご連絡ください。'); }
}
function menuSlotsApi_(body) {
  try {
    const cfg = readMenuSettings_(), selection = menuSelection_(cfg,body.menuIds);
    if (!selection.ok) return selection;
    const ym = String(body.ym || '');
    if (!/^\d{6}$/.test(ym) || Number(ym.slice(4)) < 1 || Number(ym.slice(4)) > 12) return menuError_('ym_invalid','年月が正しくありません。');
    const y=Number(ym.slice(0,4)), m=Number(ym.slice(4)), cache=CacheService.getScriptCache();
    const rev=PropertiesService.getScriptProperties().getProperty('MENU_AVAILABILITY_REV') || '0';
    const key='menuSlots:v1:'+menuHash_([ym,cfg.version,selection.ids,rev,CALENDAR_ID,ADDITIONAL_CALENDAR_IDS]);
    const forced=body.force===true || String(body.force)==='1' || String(body.force)==='true';
    if (!forced) {
      const raw=cache.get(key);
      if (raw) { const entry=JSON.parse(raw); if (Date.now()-entry.savedAt < 60000 && Date.now() >= entry.savedAt) {
        if (__measureCtx_) __measureCtx_.slotsCache='hit'; return entry.result;
      } }
    }
    if (__measureCtx_) __measureCtx_.slotsCache=forced?'bypass':'miss';
    const business=measurePhase_('businessTotal',()=>getCachedBusinessDays_(y,m,forced));
    const busy=measurePhase_('busyCalendars',()=>getVerifiedReservationBusy_(new Date(`${y}-${String(m).padStart(2,'0')}-01T00:00:00+09:00`),new Date(Date.UTC(y,m,1)-9*3600000)));
    const now=new Date(), slots=[];
    for(let d=1;d<=new Date(Date.UTC(y,m,0)).getUTCDate();d++) {
      const day=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      if(!menuDateAllowed_(day,now) || business.excluded.includes(day) || (business.holidays.includes(day) && !cfg.overrides[day]?.enabled)) continue;
      const schedule=menuSchedule_(cfg,day); if(!schedule.enabled) continue;
      for(let n=Math.ceil(schedule.open/30)*30;n<schedule.close;n+=30) {
        if(!menuFits_(cfg,schedule,n,selection.duration)) continue;
        const item=menuCandidate_(cfg,selection,day,n);
        if(item.start<=now || busy.some(ev=>item.start<ev.end && item.blockedEnd>ev.start)) continue;
        slots.push({slotId:item.slotId,start:item.start.toISOString(),end:item.end.toISOString()});
      }
    }
    const result={ok:true,ym,slots,version:cfg.version,menuNames:selection.names,durationMinutes:selection.duration};
    const json=JSON.stringify({savedAt:Date.now(),result});
    // CacheService has a per-value size limit. Large months remain uncached safely.
    if(json.length*3 < 95000) { try{cache.put(key,json,60);}catch(e){/* display cache optional */} }
    return result;
  } catch(e) { return menuError_('settings_unavailable','空き時間の取得に失敗しました。設定・カレンダーを確認し、もう一度お試しください。'); }
}
function menuHistorySheet_() {
  const sheet=getOperationSheet_();
  const header=sheet.getRange(1,12,1,6).getValues()[0];
  menuAssert_(MENU_HISTORY_HEADERS_.every((v,i)=>header[i]===v),'予約一覧L〜Q列の見出しを初期化してください。'); return sheet;
}
function menuStoredMeta_(row) {
  if(!row[COL.MENU_IDS]) return {menuIds:[],menuNames:[],durationMinutes:null,cleanupMinutes:0};
  let ids;try{ids=JSON.parse(row[COL.MENU_IDS]);}catch(e){throw new Error('Stored menu IDs invalid');}
  menuAssert_(Array.isArray(ids),'Stored menu IDs invalid');
  return {menuIds:ids,menuNames:String(row[COL.MENU_NAMES]||'').split(' ＋ '),durationMinutes:Number(row[COL.DURATION]),cleanupMinutes:Number(row[COL.CLEANUP]),blockedEnd:String(row[COL.BLOCKED_END]||'')};
}
function menuReplay_(row,body) {
  const base=operationReplay_(row,body); if(!base.ok) return base;
  const meta=menuStoredMeta_(row), ids=Array.isArray(body.menuIds)?[...body.menuIds].sort():[];
  if(JSON.stringify([...meta.menuIds].sort())!==JSON.stringify(ids)) return menuError_('request_content_changed','前の予約操作の結果を確認してください。');
  return Object.assign(base,meta);
}
function menuCreateApi_(body) {
  const input=validateReservationInput_(body);if(!input.ok)return input;
  body=Object.assign({},body,input);
  const uid=String(body.userId||'').trim(), requestId=String(body.requestId||'').trim();
  if(!uid || !/^[A-Za-z0-9_-]{16,80}$/.test(requestId))return menuError_('request_id_required','画面を開き直してから予約してください。');
  const lock=LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const sheet=menuHistorySheet_(), previous=findReservationOperation_(sheet,uid,requestId);
    if(previous)return menuReplay_(previous,body);
    const cfg=readMenuSettings_(), selection=menuSelection_(cfg,body.menuIds);if(!selection.ok)return selection;
    if(body.settingsVersion!==cfg.version)return menuError_('settings_changed','予約設定が変更されました。メニューから選び直してください。');
    const parsed=parseSlotId_(String(body.slotId||''));if(!parsed.ok)return parsed;
    const minute=Number(Utilities.formatDate(parsed.start,TZ,'HH'))*60+Number(Utilities.formatDate(parsed.start,TZ,'mm'));
    const schedule=menuSchedule_(cfg,parsed.ymd), candidate=menuCandidate_(cfg,selection,parsed.ymd,minute);
    if(candidate.slotId!==body.slotId || !menuFits_(cfg,schedule,minute,selection.duration))return reservationRuleError_('slot_invalid');
    if(candidate.start<=new Date())return reservationRuleError_('slot_started');
    if(!menuDateAllowed_(parsed.ymd,new Date()))return reservationRuleError_('day_too_far');
    const b=getCachedBusinessDays_(Number(parsed.ymd.slice(0,4)),Number(parsed.ymd.slice(5,7)),true);
    if(b.excluded.includes(parsed.ymd)||(b.holidays.includes(parsed.ymd)&&!cfg.overrides[parsed.ymd]?.enabled))return reservationRuleError_('day_closed');
    const rows=sheet.getDataRange().getValues().slice(1);
    const today=Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd');
    if(Number(MAX_RESERVATIONS)>0 && rows.filter(r=>String(r[COL.USER_ID])===uid&&String(r[COL.STATUS])===STATUS_RESERVED&&toYmd_(r[COL.DATE])>=today).length>=Number(MAX_RESERVATIONS))return reservationRuleError_('reservation_limit');
    if(getVerifiedReservationBusy_(candidate.start,candidate.blockedEnd).length)return {ok:false,message:'slot_already_reserved'};
    const rid=generateReservationId_(), label=parsed.timeLabel, names=selection.names.join(' ＋ ');
    const cal=CalendarApp.getCalendarById(CALENDAR_ID);if(!cal)return {ok:false,message:'calendar_not_found'};
    let event;
    try { event=cal.createEvent(`[予約 #${rid}] ${input.name}｜${names}`,candidate.start,candidate.blockedEnd,{description:[`reservationId: ${rid}`,`userId: ${uid}`,`tel: ${input.tel}`,`menu: ${names}`,`施術予約時間: ${label}`,`片付け: ${selection.cleanup}分`,`施術終了: ${candidate.end.toISOString()}`,input.note?`note: ${input.note}`:''].filter(Boolean).join('\n')}); }
    catch(e){return {ok:false,message:'calendar_create_failed'};}
    try {appendReservationTextRow_(sheet,[rid,uid,parsed.dateStr,label,input.name,input.tel,input.note,new Date(),STATUS_RESERVED,event.getId(),requestId,JSON.stringify(selection.ids),names,selection.duration,selection.cleanup,candidate.blockedEnd.toISOString(),cfg.version]);}
    catch(e){try{event.deleteEvent();}catch(rollback){console.error('MENU_RESERVATION_ROLLBACK_FAILED '+rid);}return {ok:false,message:'sheet_write_failed'};}
    try {invalidateCaches_(uid,parsed.ymd,getIdsKey_());}catch(e){console.warn('Reservation saved; cache refresh failed');}
    const notifications={};
    const msg=`【ご予約確定】\n予約ID：${rid}\n日時：${parsed.dateStr} ${label}\nメニュー：${names}\nお名前：${input.name}\n\n※このメッセージが控えになります。`;
    notifications.user=sendReservationNotice_('create',rid,'user',uid,msg);
    notifications.admin=sendReservationNotice_('create',rid,'admin',ADMIN_USER_ID,msg);
    return {ok:true,reservationId:rid,slotId:candidate.slotId,start:candidate.start.toISOString(),end:candidate.end.toISOString(),eventId:event.getId(),menuIds:selection.ids,menuNames:selection.names,durationMinutes:selection.duration,cleanupMinutes:selection.cleanup,blockedEnd:candidate.blockedEnd.toISOString(),notifications};
  } catch(e){return {ok:false,message:'lock_or_internal_error'};}
  finally{try{lock.releaseLock();}catch(e){}}
}

// Run once manually, only in this development project. Does not delete booking rows.
function initializeMenuReservationSettings() {
  menuAssert_(SHEET_ID==='1RMDkk4_VZh3Vugy_UBCI7Jzb-Qce-UyQGjh7qDh-fF0' && CALENDAR_ID==='49e7b77734692f4b92ebedc933d135645c2d7c29ad91385a18842948b532739e@group.calendar.google.com','開発テスト環境でのみ実行できます。');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const book=SpreadsheetApp.openById(SHEET_ID), history=book.getSheetByName(SHEET_NAME);
    menuAssert_(history && String(history.getRange(1,11).getValue())==='操作ID','予約一覧K列の見出しを確認してください。');
    const defs=[
      [['項目','値','説明'],['開店','09:00','共通の開店時刻'],['閉店','17:00','施術はこの時刻までに終了'],['昼休みを使用','FALSE','TRUE/FALSE'],['昼休み開始','12:00','使用時の共通開始時刻'],['昼休み終了','13:00','使用時の共通終了時刻'],['片付け時間（分）','30','1回の来店の最後に追加'],['閉店後の片付けを許可','TRUE','FALSEなら片付けまで閉店時刻内'],['片付けも昼休みに重ねない','TRUE','休憩の確保時間に片付けを含める']],
      [['ID','メニュー名','施術目安（分）','予約時間（分）','単独のみ','有効'],['cut','カット','60','60','FALSE','TRUE'],['color','カラー','60','60','FALSE','TRUE'],['treatment','トリートメント','60','60','FALSE','TRUE'],['perm_short','パーマ（ショート）','60','60','FALSE','TRUE'],['perm_long','パーマ（ロング）','90','90','FALSE','TRUE'],['shampoo_blow','シャンプー・ブロー','20','30','TRUE','TRUE']],
      [['曜日番号','曜日','営業','開店','閉店','昼休み開始','昼休み終了'],['0','日','FALSE','','','',''],['1','月','TRUE','','','',''],['2','火','TRUE','','','',''],['3','水','TRUE','','','',''],['4','木','TRUE','','','',''],['5','金','TRUE','','','',''],['6','土','TRUE','09:00','12:00','なし','なし']],
      [['日付','営業','開店','閉店','昼休み開始','昼休み終了']]
    ];
    // Preflight all destinations before the first write. Never overwrite unknown headers.
    const hh=history.getRange(1,12,1,6).getValues()[0];
    menuAssert_(hh.every((v,i)=>v===''||v===MENU_HISTORY_HEADERS_[i]),'予約一覧L〜Q列に別の見出しがあります。中止しました。');
    if(hh.every(v=>v==='') && history.getLastRow()>1)menuAssert_(history.getRange(2,12,history.getLastRow()-1,6).getValues().every(r=>r.every(v=>v==='')),'予約一覧L〜Q列に既存データがあります。中止しました。');
    MENU_SETTING_TABS_.forEach((name,i)=>{const sh=book.getSheetByName(name);if(sh&&sh.getLastRow()>0)menuAssert_(defs[i][0].every((v,j)=>sh.getRange(1,j+1).getValue()===v),name+'に別の見出しがあります。中止しました。');});
    MENU_SETTING_TABS_.forEach((name,i)=>{let sh=book.getSheetByName(name);if(sh&&sh.getLastRow()>0)return;sh=sh||book.insertSheet(name);const data=defs[i],width=data[0].length;sh.getRange(1,1,data.length,width).setNumberFormat('@').setValues(data);sh.setFrozenRows(1);sh.getRange(1,1,1,width).setFontWeight('bold');sh.autoResizeColumns(1,width);});
    history.getRange(1,12,1,6).setValues([MENU_HISTORY_HEADERS_]);SpreadsheetApp.flush();
    readMenuSettings_();console.log('メニュー設定の準備が完了しました。既存予約・既存の設定値は削除していません。');
  }finally{lock.releaseLock();}
}

// Read-only admin check after editing settings. Does not move/cancel old bookings.
function checkMenuReservationSettings() {
  const cfg=readMenuSettings_(), sheet=menuHistorySheet_(), rows=sheet.getDataRange().getValues().slice(1);
  const today=Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd'), businessByMonth={}, warnings=[];
  for(const row of rows) {
    if(String(row[COL.STATUS])!==STATUS_RESERVED)continue;
    const day=toYmd_(row[COL.DATE]);if(day<today)continue;
    const rid=String(row[COL.RESERVATION_ID]);
    try{
      const p=parseSlotId_(day.replaceAll('-','')+'_'+row[COL.TIME]);menuAssert_(p.ok,'予約日時が不正');
      const duration=Math.round((p.end-p.start)/60000), meta=menuStoredMeta_(row);
      const localCfg=Object.assign({},cfg,{cleanup:meta.cleanupMinutes||0});
      const minute=Number(Utilities.formatDate(p.start,TZ,'HH'))*60+Number(Utilities.formatDate(p.start,TZ,'mm'));
      const ym=day.slice(0,7);
      if(!businessByMonth[ym])businessByMonth[ym]=getCachedBusinessDays_(Number(day.slice(0,4)),Number(day.slice(5,7)),true);
      const b=businessByMonth[ym];
      if(!menuFits_(localCfg,menuSchedule_(cfg,day),minute,duration)||b.excluded.includes(day)||(b.holidays.includes(day)&&!cfg.overrides[day]?.enabled))warnings.push({reservationId:rid,date:day,reason:'現在の営業時間・昼休み・休業設定との重なりを確認してください'});
    }catch(e){warnings.push({reservationId:rid,date:day,reason:'保存済みの予約日時を確認してください'});}
  }
  console.log('設定確認：正常。既存予約との確認事項 '+warnings.length+'件');
  warnings.forEach(entry=>console.log(JSON.stringify(entry)));
  return {ok:true,warnings};
}
