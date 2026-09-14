// capture.js
// Mo trang minhngoc.net (trang nay mac dinh hien 7 ngay gan nhat: hom nay -> lui 6 ngay).
// Tach rieng tung block theo tung ngay, BO QUA ngay hom nay (chua co ket qua luc 7h sang),
// chi chup + gui 6 ngay con lai (n-6 -> n-1). Ngay nao da gui roi (luu trong sent-log.json)
// thi bo qua, giup nhanh hon va anh net hon (khong phai ghep nhieu ngay thanh 1 anh dai).
//
// Bien moi truong can co (dat trong GitHub Secrets):
//   TELEGRAM_BOT_TOKEN  - token cua bot Telegram (lay tu @BotFather)
//   TELEGRAM_CHAT_ID    - id cua chat/nguoi nhan
//   TARGET_URL          - (tuy chon) URL trang ket qua, mac dinh la mien Bac

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const TARGET_URL = process.env.TARGET_URL || 'https://www.minhngoc.net/kqxs/mien-bac.html';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// So ngay toi da bo qua tinh tu "hom nay" (khong tinh hom nay): n-6 -> n-1 = 6 ngay
const DAYS_BACK = 6;
// File luu lai cac ngay da gui thanh cong, de lan sau khong gui lai
const SENT_LOG_PATH = path.join(process.cwd(), 'sent-log.json');
// Chi giu lai log trong X ngay gan nhat de file khong phinh to theo thoi gian
const KEEP_LOG_DAYS = 40;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Thieu TELEGRAM_BOT_TOKEN hoac TELEGRAM_CHAT_ID trong bien moi truong.');
  process.exit(1);
}

function loadSentLog() {
  try {
    const raw = fs.readFileSync(SENT_LOG_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.sentDates) ? data.sentDates : [];
  } catch (_) {
    return [];
  }
}

// Chuyen "dd-mm-yyyy" thanh Date object de so sanh/loc
function parseDdMmYyyy(key) {
  const [d, m, y] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function saveSentLog(sentDates) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - KEEP_LOG_DAYS * 24 * 60 * 60 * 1000);
  const pruned = [...new Set(sentDates)].filter((key) => {
    const d = parseDdMmYyyy(key);
    return !isNaN(d.getTime()) && d >= cutoff;
  });
  pruned.sort((a, b) => parseDdMmYyyy(a) - parseDdMmYyyy(b));
  fs.writeFileSync(SENT_LOG_PATH, JSON.stringify({ sentDates: pruned }, null, 2) + '\n', 'utf8');
  return pruned;
}

async function sendDocumentToTelegram(buffer, filename, caption) {
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('caption', caption);
  form.append('document', new Blob([buffer], { type: 'image/png' }), filename);

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error('Telegram tra ve loi: ' + JSON.stringify(data));
  }
  return data;
}

async function sendTextToTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
  return res.json();
}

async function run() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1600, deviceScaleFactor: 2 });
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    await page.waitForSelector('body');
    try {
      await page.evaluate(() => document.fonts && document.fonts.ready);
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 3000));

    // Tim tung block ket qua theo tung ngay, gan attribute data-mn-day = "dd-mm-yyyy" cho moi block,
    // tra ve danh sach cac ngay theo thu tu tren-xuong (moi nhat -> cu nhat)
    const dayKeysNewestFirst = await page.evaluate(() => {
      function normText(s) {
        return (s || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
      }

      const REQUIRED_LABELS = ['Giải ĐB', 'Giải nhất', 'Giải nhì', 'Giải bảy'];

      function containsAllLabels(el) {
        const t = normText(el.textContent);
        return REQUIRED_LABELS.every((label) => t.includes(label));
      }

      function findGiaiDbCells() {
        const cells = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          const t = normText(node.textContent);
          if (/^Giải\s*ĐB$/i.test(t) || t === 'Giải ĐB') {
            cells.push(node.parentElement);
          }
        }
        return cells;
      }

      function climbToFullBlock(cell) {
        let el = cell;
        let steps = 0;
        while (el && steps < 12) {
          if (containsAllLabels(el)) return el;
          el = el.parentElement;
          steps++;
        }
        return cell.closest('table') || cell;
      }

      function findResultBlocks() {
        const raw = findGiaiDbCells().map(climbToFullBlock).filter(Boolean);
        const unique = [];
        raw.forEach((el) => {
          if (!unique.includes(el)) unique.push(el);
        });
        return unique.filter((el) => !unique.some((other) => other !== el && el.contains(other)));
      }

      const blocks = findResultBlocks();
      if (blocks.length === 0) return [];

      // Sap xep theo vi tri tren trang: tren cung = moi nhat (hom nay), duoi cung = cu nhat
      const sorted = blocks.slice().sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.top - rb.top;
      });

      // Lay toan bo cac dong "Ngay: dd/mm/yyyy" tren trang theo dung thu tu xuat hien trong DOM
      const bodyText = document.body.innerText || document.body.textContent || '';
      const dateMatches = [...bodyText.matchAll(/Ngày:\s*(\d{2})\/(\d{2})\/(\d{4})/g)].map(
        (m) => `${m[1]}-${m[2]}-${m[3]}`
      );

      const dayKeys = [];
      sorted.forEach((el, idx) => {
        const key = dateMatches[idx];
        if (key) {
          el.setAttribute('data-mn-day', key);
          dayKeys.push(key);
        }
      });
      return dayKeys;
    });

    if (dayKeysNewestFirst.length === 0) {
      await sendTextToTelegram(
        '⚠️ Khong tim thay khoi ket qua xo so tren trang. Trang co the da doi cau truc, can kiem tra lai script.'
      );
      process.exit(1);
    }

    // Bo qua block dau tien (hom nay = n), chi lay toi da DAYS_BACK ngay tiep theo (n-1 -> n-6)
    const targetDayKeys = dayKeysNewestFirst.slice(1, 1 + DAYS_BACK);

    if (targetDayKeys.length === 0) {
      console.log('Khong co ngay nao trong pham vi n-6 -> n-1 de xu ly.');
      return;
    }

    const sentDates = loadSentLog();
    const sentSet = new Set(sentDates);

    // Chi xu ly nhung ngay CHUA co trong sent-log, gui theo thu tu tu cu -> moi cho de theo doi
    const toProcess = targetDayKeys.filter((k) => !sentSet.has(k)).reverse();

    if (toProcess.length === 0) {
      console.log('Tat ca cac ngay trong pham vi da duoc gui truoc do. Khong can chup lai.');
      return;
    }

    console.log('Cac ngay se chup + gui:', toProcess.join(', '));

    let anySuccess = false;
    for (const dayKey of toProcess) {
      try {
        const el = await page.$(`[data-mn-day="${dayKey}"]`);
        if (!el) {
          console.warn(`Khong lay duoc elementHandle cho ngay ${dayKey}, bo qua.`);
          continue;
        }

        const buffer = await el.screenshot({ type: 'png' });
        const [d, m, y] = dayKey.split('-');
        const displayDate = `${d}/${m}/${y}`;

        await sendDocumentToTelegram(buffer, `ket-qua_${dayKey}.png`, `Ket qua xo so - ${displayDate}`);
        console.log(`Da gui anh ngay ${displayDate} qua Telegram thanh cong.`);

        sentSet.add(dayKey);
        anySuccess = true;

        // Cho 1 chut giua cac lan gui de tranh bi Telegram rate-limit
        await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        console.error(`Loi khi xu ly ngay ${dayKey}:`, err);
        try {
          await sendTextToTelegram(`❌ Loi khi chup/gui anh ket qua ngay ${dayKey}: ${err.message}`);
        } catch (_) {}
      }
    }

    if (anySuccess) {
      saveSentLog([...sentSet]);
      console.log('Da cap nhat sent-log.json.');
    }
  } finally {
    await browser.close();
  }
}

run();
