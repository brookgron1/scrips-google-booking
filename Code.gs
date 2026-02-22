function doGet(e) {
  const page = (e && e.parameter && e.parameter.page) ? String(e.parameter.page) : 'public';

  const t = HtmlService.createTemplateFromFile('Index');
  t.PAGE = page;
  t.ADMIN_KEY = (e && e.parameter && e.parameter.key) ? String(e.parameter.key) : '';
  t.FOCUS_ID = (e && e.parameter && e.parameter.id) ? String(e.parameter.id) : '';

  return t.evaluate()
    .setTitle('Nha Trang Escape Room — by CRYPT-TIC')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* =========================
   CONFIG
========================= */
const SPREADSHEET_ID = '1vHuPgM4QSc78tTHD_iXLn8Yr7Nom0DhnhfakDph7TCs';
const BOOKINGS_SHEET_NAME = 'Bookings';

const TZ = 'Asia/Ho_Chi_Minh';
const SLOT_MINUTES = 60;
const BUFFER_MINUTES = 15;
const LEAD_MINUTES = 15;

const OPEN_HOUR = 11;
const CLOSE_HOUR = 23;

// Email notify
const OWNER_EMAIL = 'brook.gron1@gmail.com';
const ADMIN_KEY_SECRET = '2711';
const NOTIFY_ON_PENDING = true;

// Calendar sync
const SYNC_TO_CALENDAR = true;
const CALENDAR_ID = 'primary';

// === NEW PRICING CONFIG (8 player max enforced) ===
const PRICE_ARRIVAL_PER_PERSON = 400000;
const PRICE_PREPAID_PER_PERSON = 350000;
const DEPOSIT_ONLY_AMOUNT = 350000;
const MIN_CHARGE_PLAYERS = 4;
const MAX_PLAYERS = 8;                    // ← 8 player maximum
const USD_RATE = 25000;                   // 25,000 VND = $1

/* =========================
   HELPERS
========================= */
function getBookingsSheet_(){
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName(BOOKINGS_SHEET_NAME);
  if (!sh) throw new Error('Bookings sheet not found');
  return sh;
}

function getHeaderMap_(sh){
  const headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach((h,i)=> map[String(h).trim()] = i+1);
  return map;
}

function requireCols_(map, cols){
  const missing = cols.filter(c => !map[c]);
  if (missing.length) throw new Error('Missing columns: ' + missing.join(', '));
}

function normalizeTime_(t){
  const m = String(t || '').match(/^(\d{2}):(\d{2})$/);
  if (!m) throw new Error('Bad time');
  return `${m[1]}:${m[2]}`;
}

function parseVN_(dateStr, timeStr){
  return new Date(`${dateStr}T${timeStr}:00+07:00`);
}

function isSameDayVN_(dateStr){
  const todayVN = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  return String(dateStr) === todayVN;
}

function assertWithinHours_(timeStr){
  const [hh, mm] = timeStr.split(':').map(Number);
  if (mm !== 0) throw new Error('Only full hours allowed');
  if (hh < OPEN_HOUR || hh > CLOSE_HOUR) throw new Error('Outside booking hours');
}

function generateId_(){
  return 'VN-' + Utilities.getUuid().slice(0,8).toUpperCase();
}

function findRowByBookingId_(sh, map, bookingId){
  const last = sh.getLastRow();
  if (last <= 1) return null;
  const col = map['booking_id'];
  const vals = sh.getRange(2, col, last-1, 1).getValues();
  for (let i=0;i<vals.length;i++){
    if (String(vals[i][0]) === String(bookingId)) return i+2;
  }
  return null;
}

/* =========================
   NEW: PRICING CALCULATOR (server-side, always correct)
========================= */
function computePricingFromOption_(option){
  if (String(option) === 'deposit'){
    return {
      option: 'deposit',
      people_label: 'DEPOSIT',
      players: 0,
      charged_people: 0,
      prepay_vnd: DEPOSIT_ONLY_AMOUNT,
      arrival_vnd: DEPOSIT_ONLY_AMOUNT,
      deposit_vnd: DEPOSIT_ONLY_AMOUNT
    };
  }

  const players = Math.max(0, parseInt(option, 10) || 0);
  const charged = Math.max(players, MIN_CHARGE_PLAYERS);

  const prepay = PRICE_PREPAID_PER_PERSON * charged;
  const arrival = PRICE_ARRIVAL_PER_PERSON * charged;

  return {
    option: String(players),
    people_label: players,
    players,
    charged_people: charged,
    prepay_vnd: prepay,
    arrival_vnd: arrival,
    deposit_vnd: DEPOSIT_ONLY_AMOUNT
  };
}

function vndToUsd_(vnd){
  return Math.round((Number(vnd) / USD_RATE) * 100) / 100; // 2 decimals
}

/* =========================
   AVAILABILITY
========================= */
function slotTaken_(dateStr, timeStr){
  const sh = getBookingsSheet_();
  const map = getHeaderMap_(sh);
  requireCols_(map, ['date','start_time','status']);

  const last = sh.getLastRow();
  if (last <= 1) return false;

  const data = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  const target = parseVN_(dateStr, timeStr).getTime();
  const windowMs = (SLOT_MINUTES + BUFFER_MINUTES) * 60 * 1000;

  const cDate = map['date'] - 1;
  const cStart = map['start_time'] - 1;
  const cStatus = map['status'] - 1;

  for (const r of data){
    const status = String(r[cStatus] || '').toUpperCase();
    if (status !== 'APPROVED') continue;

    const ds = (r[cDate] instanceof Date)
      ? Utilities.formatDate(r[cDate], TZ, 'yyyy-MM-dd')
      : String(r[cDate] || '').trim();

    const ts = normalizeTime_(String(r[cStart] || '').trim());
    const existing = parseVN_(ds, ts).getTime();
    if (!isNaN(existing) && Math.abs(existing - target) < windowMs) return true;
  }
  return false;
}

function apiGetAvailability(dateStr){
  const times = [];
  const sameDay = isSameDayVN_(dateStr);

  for (let h = OPEN_HOUR; h <= CLOSE_HOUR; h++){
    const hh = ('0' + h).slice(-2);
    const time = `${hh}:00`;

    let tooSoon = false;
    if (sameDay){
      const start = parseVN_(dateStr, time).getTime();
      const minStart = Date.now() + LEAD_MINUTES * 60 * 1000;
      tooSoon = (start <= minStart);
    }

    const available = !tooSoon && !slotTaken_(dateStr, time);
    times.push({ time, available });
  }
  return { ok:true, date:dateStr, times, bufferMinutes: BUFFER_MINUTES };
}

/* =========================
   BOOKING WRITE + EMAIL (now with fixed pricing)
========================= */
function apiRequestBooking(payload){
  const sh = getBookingsSheet_();
  const map = getHeaderMap_(sh);

  requireCols_(map, [
    'booking_id','location_id','date','start_time','end_time',
    'people','charged_people','total_vnd','deposit_vnd',
    'status','name','phone','lang',
    'pay_method','payment_note','proof_link',
    'created_at','expires_at','confirmed_at','admin_note',
    'EventId','NotifiedAt'
  ]);

  const dateStr = String(payload.date || '').trim();
  const timeStr = normalizeTime_(payload.time);
  assertWithinHours_(timeStr);

  const name = String(payload.name || '').trim();
  const phone = String(payload.phone || '').trim();
  const lang = String(payload.lang || 'en').trim();

  if (!dateStr || !timeStr || !name || !phone){
    return { ok:false, error:'MISSING_FIELDS' };
  }

  // === NEW: Validate 8 player max + option ===
  const option = String(payload.option || '').trim();
  let playersNum = 0;
  if (option !== 'deposit'){
    playersNum = parseInt(option, 10);
    if (isNaN(playersNum) || playersNum < 1 || playersNum > MAX_PLAYERS){
      return { ok:false, error:'INVALID_OPTION', message:`Players must be 1-${MAX_PLAYERS} or "deposit"` };
    }
  }

  // Same-day lead time check
  if (isSameDayVN_(dateStr)){
    const startMs = parseVN_(dateStr, timeStr).getTime();
    const minStart = Date.now() + LEAD_MINUTES * 60 * 1000;
    if (startMs <= minStart){
      return { ok:false, error:'TOO_SOON', leadMinutes: LEAD_MINUTES };
    }
  }

  if (slotTaken_(dateStr, timeStr)){
    return { ok:false, error:'SLOT_TAKEN', bufferMinutes: BUFFER_MINUTES };
  }

  const start = parseVN_(dateStr, timeStr);
  const end = new Date(start.getTime() + SLOT_MINUTES * 60 * 1000);
  const endTimeStr = Utilities.formatDate(end, TZ, 'HH:mm');

  const bookingId = generateId_();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 2 * 60 * 60 * 1000);

  // === NEW: Server computes ALL pricing from option ===
  const pricing = computePricingFromOption_(option);

  const row = new Array(sh.getLastColumn()).fill('');

  row[map['booking_id'] - 1] = bookingId;
  row[map['location_id'] - 1] = String(payload.location_id || 'NT');

  row[map['date'] - 1] = dateStr;
  row[map['start_time'] - 1] = timeStr;
  row[map['end_time'] - 1] = endTimeStr;

  row[map['people'] - 1] = pricing.people_label;
  row[map['charged_people'] - 1] = pricing.charged_people;
  row[map['total_vnd'] - 1] = pricing.prepay_vnd;      // total_vnd = prepaid total
  row[map['deposit_vnd'] - 1] = pricing.deposit_vnd;

  row[map['status'] - 1] = 'PENDING';
  row[map['name'] - 1] = name;
  row[map['phone'] - 1] = phone;
  row[map['lang'] - 1] = lang;

  row[map['pay_method'] - 1] = String(payload.pay_method || 'vietqr');
  row[map['payment_note'] - 1] = String(payload.payment_note || '');
  row[map['proof_link'] - 1] = String(payload.proof_link || '');

  row[map['created_at'] - 1] = createdAt;
  row[map['expires_at'] - 1] = expiresAt;
  row[map['confirmed_at'] - 1] = '';
  row[map['admin_note'] - 1] = '';

  row[map['EventId'] - 1] = '';
  row[map['NotifiedAt'] - 1] = '';

  sh.appendRow(row);

  const newRowIdx = sh.getLastRow();
  if (NOTIFY_ON_PENDING) notifyPendingEmail_(sh, newRowIdx);

  // Return pricing so frontend can display exact amounts
  return { 
    ok:true, 
    booking_id: bookingId, 
    status:'PENDING', 
    pricing: {
      prepay_vnd: pricing.prepay_vnd,
      prepay_usd: vndToUsd_(pricing.prepay_vnd),
      arrival_vnd: pricing.arrival_vnd,
      arrival_usd: vndToUsd_(pricing.arrival_vnd),
      deposit_vnd: pricing.deposit_vnd,
      deposit_usd: vndToUsd_(pricing.deposit_vnd),
      charged_people: pricing.charged_people,
      players: pricing.players
    }
  };
}

// (notifyPendingEmail_, adminGetBooking_, adminApprove_, adminReject_ functions remain exactly the same as your original)
function notifyPendingEmail_(sh, rowIndex){
  const map = getHeaderMap_(sh);
  requireCols_(map, ['status','NotifiedAt','booking_id','date','start_time','end_time','name','phone']);

  const status = String(sh.getRange(rowIndex, map['status']).getValue() || '').toUpperCase();
  if (status !== 'PENDING') return;

  const already = sh.getRange(rowIndex, map['NotifiedAt']).getValue();
  if (already) return;

  const bookingId = sh.getRange(rowIndex, map['booking_id']).getValue();
  const dateStr = sh.getRange(rowIndex, map['date']).getValue();
  const startTime = sh.getRange(rowIndex, map['start_time']).getValue();
  const endTime = sh.getRange(rowIndex, map['end_time']).getValue();
  const name = sh.getRange(rowIndex, map['name']).getValue();
  const phone = sh.getRange(rowIndex, map['phone']).getValue();

  const baseUrl = ScriptApp.getService().getUrl();
  const detailUrl = `${baseUrl}?page=admin_detail&key=${encodeURIComponent(ADMIN_KEY_SECRET)}&id=${encodeURIComponent(bookingId)}`;

  const subject = `PENDING: ${dateStr} ${startTime} (${bookingId})`;
  const htmlBody = `
  <div style="font-family:Arial,sans-serif;line-height:1.5;">
    <h2 style="margin:0 0 8px;">New booking request (PENDING)</h2>
    <div><b>When:</b> ${dateStr} ${startTime}–${endTime}</div>
    <div><b>Name:</b> ${name}</div>
    <div><b>Phone:</b> ${phone}</div>
    <div style="margin-top:14px;">
      <a href="${detailUrl}"
         style="display:inline-block;padding:12px 16px;border-radius:10px;
                background:#2563eb;color:#fff;text-decoration:none;font-weight:700;">
        Open booking (Approve / Reject)
      </a>
    </div>
    <div style="margin-top:10px;color:#666;font-size:12px;">
      Approve = blocks the time + adds to Google Calendar.
    </div>
  </div>`;

  MailApp.sendEmail({ to: OWNER_EMAIL, subject, htmlBody });

  sh.getRange(rowIndex, map['NotifiedAt']).setValue(new Date());
}

function adminGetBooking_(adminKey, bookingId){
  if (String(adminKey) !== String(ADMIN_KEY_SECRET)) return { ok:false, error:'UNAUTHORIZED' };

  const sh = getBookingsSheet_();
  const map = getHeaderMap_(sh);

  const rowIndex = findRowByBookingId_(sh, map, bookingId);
  if (!rowIndex) return { ok:false, error:'NOT_FOUND' };

  const get = (colName) => map[colName] ? sh.getRange(rowIndex, map[colName]).getValue() : '';

  return {
    ok:true,
    rowIndex,
    booking: {
      booking_id: get('booking_id'),
      location_id: get('location_id'),
      date: get('date'),
      start_time: get('start_time'),
      end_time: get('end_time'),
      people: get('people'),
      charged_people: get('charged_people'),
      total_vnd: get('total_vnd'),
      deposit_vnd: get('deposit_vnd'),
      status: get('status'),
      name: get('name'),
      phone: get('phone'),
      lang: get('lang'),
      pay_method: get('pay_method'),
      payment_note: get('payment_note'),
      proof_link: get('proof_link'),
      created_at: get('created_at'),
      expires_at: get('expires_at'),
      confirmed_at: get('confirmed_at'),
      admin_note: get('admin_note'),
      EventId: get('EventId')
    }
  };
}

function adminApprove_(adminKey, bookingId){
  if (String(adminKey) !== String(ADMIN_KEY_SECRET)) return { ok:false, error:'UNAUTHORIZED' };

  const sh = getBookingsSheet_();
  const map = getHeaderMap_(sh);
  requireCols_(map, ['booking_id','date','start_time','end_time','status','EventId','confirmed_at']);

  const rowIndex = findRowByBookingId_(sh, map, bookingId);
  if (!rowIndex) return { ok:false, error:'NOT_FOUND' };

  sh.getRange(rowIndex, map['status']).setValue('APPROVED');
  sh.getRange(rowIndex, map['confirmed_at']).setValue(new Date());

  if (SYNC_TO_CALENDAR) {
    const eventCell = sh.getRange(rowIndex, map['EventId']);
    if (!eventCell.getValue()){
      const dateStr = String(sh.getRange(rowIndex, map['date']).getValue() || '').trim();
      const startTime = normalizeTime_(String(sh.getRange(rowIndex, map['start_time']).getValue() || '').trim());
      const endTime = normalizeTime_(String(sh.getRange(rowIndex, map['end_time']).getValue() || '').trim());

      const start = parseVN_(dateStr, startTime);
      const end = parseVN_(dateStr, endTime);

      const name = map['name'] ? sh.getRange(rowIndex, map['name']).getValue() : '';
      const phone = map['phone'] ? sh.getRange(rowIndex, map['phone']).getValue() : '';
      const people = map['people'] ? sh.getRange(rowIndex, map['people']).getValue() : '';
      const payMethod = map['pay_method'] ? sh.getRange(rowIndex, map['pay_method']).getValue() : '';

      const title = `Escape Room — ${people} (${bookingId})`;
      const desc = `Name: ${name}\nPhone: ${phone}\nPay: ${payMethod || 'vietqr'}`.trim();

      const cal = CalendarApp.getCalendarById(CALENDAR_ID);
      const ev = cal.createEvent(title, start, end, { description: desc });
      eventCell.setValue(ev.getId());
    }
  }

  return { ok:true };
}

function adminReject_(adminKey, bookingId, note){
  if (String(adminKey) !== String(ADMIN_KEY_SECRET)) return { ok:false, error:'UNAUTHORIZED' };

  const sh = getBookingsSheet_();
  const map = getHeaderMap_(sh);
  requireCols_(map, ['booking_id','status','admin_note']);

  const rowIndex = findRowByBookingId_(sh, map, bookingId);
  if (!rowIndex) return { ok:false, error:'NOT_FOUND' };

  sh.getRange(rowIndex, map['status']).setValue('REJECTED');
  sh.getRange(rowIndex, map['admin_note']).setValue(String(note || '').trim());
  return { ok:true };
}
