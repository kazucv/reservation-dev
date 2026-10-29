// =====================================
// config.gs (LIFF版 / クリーン構成)
// =====================================

// ---------- Environment ----------
const APP_NAME = "LIFF Reserve";
const TZ = "Asia/Tokyo";

// ---------- Google Calendar ----------
const CALENDAR_ID = '49e7b77734692f4b92ebedc933d135645c2d7c29ad91385a18842948b532739e@group.calendar.google.com'; // 予約を書き込む

// 予約可否判定（ブロック用：個人予定なども含めてbusy判定する）
const ADDITIONAL_CALENDAR_IDS = [];

// ---------- Spreadsheet ----------
const SHEET_ID = '1RMDkk4_VZh3Vugy_UBCI7Jzb-Qce-UyQGjh7qDh-fF0';

// 予約データの保存先
const SHEET_NAME = "予約一覧";

// 営業除外日（任意：使うなら）
const EXCLUDED_SHEET_NAME = "営業除外日";

// 祝日一覧（任意：使うなら）
const SHEET_NAME_HOLIDAYS = "祝日一覧";
const JP_HOLIDAY_CALENDAR_ID = "ja.japanese#holiday@group.v.calendar.google.com";

const EXCLUDE_STATUS_CLOSED = '休業';
const EXCLUDE_STATUS_OPEN = '営業';

const ADMIN_USER_ID = 'U9f0de5377ba0410959bd368144d9df12'; //管理者LINE ID


// ================================
// 管理者通知設定
// ================================

// true : 予約確定／キャンセル時に即時通知
// false: 即時通知しない
const ADMIN_NOTIFY_IMMEDIATE = false;

// true : 1日1通の予約まとめを送信（トリガー実行）
// false: まとめ通知を送らない
const ADMIN_NOTIFY_DAILY_SUMMARY = false;


// ---------- Columns (予約一覧) ----------
const COL = {
  RESERVATION_ID: 0, // A 予約番号
  USER_ID: 1,        // B ユーザーID
  DATE: 2,           // C 予約日 (YYYY-MM-DD 推奨)
  TIME: 3,           // D 時間帯 (例: "10:00〜11:00")
  NAME: 4,           // E 名前
  TEL: 5,            // F 電話番号（先頭0保持したいなら文字列で入れる）
  NOTE: 6,           // G 備考
  CREATED_AT: 7,     // H 登録日時
  STATUS: 8,         // I ステータス（"予約済" / "キャンセル済" など）
  EVENT_ID: 9,       // J イベントID
  OPERATION_ID: 10,  // K 操作ID
};

// ---------- Status ----------
const STATUS_RESERVED = "予約済";
const STATUS_CANCELED = "キャンセル済";

// ---------- Business Rules ----------
const MIN_DAYS_AHEAD = 0;   // 今日から何日後以降を予約可にするか
const MAX_RESERVATIONS = 15; // 0なら無制限（使うなら実装側で解釈）

// 受付ルール none / ok / am / pm
// 0:日 1:月 ... 6:土
const WEEKDAY_RULES = {
  0: "none",
  1: "ok",
  2: "ok",
  3: "ok",
  4: "ok",
  5: "ok",
  6: "am",
};

// スロット（表示用ラベル）
// ※LIFF側はこの文字列を送るだけでOKにするのが運用ラク
// TIME_SLOTS_* はすべて「開始〜終了をそのまま使う」前提（例：10:00〜11:00）
// slotId は "YYYYMMDD_HH:MM"（開始時刻）で表す
const TIME_SLOTS_AM = ["09:00〜10:00", "10:00〜11:00", "11:00〜12:00"];
const TIME_SLOTS_PM = ["13:00〜14:00", "14:00〜15:00", "15:00〜16:00", "16:00〜17:00"];

// ==========================
// 📌 LIFFログ設定
// ==========================
const IS_DEBUG = false; // 本番でも true でOK（軽量なので）
const LOG_SHEET_ID = '1zDOD83G3OSLY710A2nBXJxm9df6dReKaGR7V-6CX19I';
const LOG_SHEET_NAME = 'LIFF用ログ';
