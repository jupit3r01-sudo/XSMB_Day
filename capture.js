// capture.js
// Mo trang minhngoc.net (trang nay mac dinh hien 7 ngay gan nhat: hom nay -> lui 6 ngay).
// Tach rieng tung block theo tung ngay, BO QUA ngay hom nay (chua co ket qua luc 7h sang),
// GHEP toan bo cac ngay con lai (n-6 -> n-1) thanh 1 anh DUY NHAT roi gui 1 lan qua Telegram.
// Ngay nao da gui roi (luu trong sent-log.json) thi bo qua khoi anh ghep, tranh gui lai.
//
// Bien moi truong can co (dat trong GitHub Secrets):
//   TELEGRAM_BOT_TOKEN  - token cua bot Telegram (lay tu @BotFather)
//   TELEGRAM_CHAT_ID    - id cua chat/nguoi nhan
//   TARGET_URL          - (tuy chon) URL trang ket qua, mac dinh la mien Bac
//
// Bien moi truong CHI DUNG DE TEST (khong can khi chay thuc te qua GitHub Actions):
//   LOCAL_TEST=1        - luu anh ghep ra file local (./debug-output.png) de xem thu,
//                         KHONG gui Telegram va KHONG ghi sent-log.json
//   IGNORE_SENT_LOG=1   - bo qua sent-log.json, coi nhu chua ngay nao duoc gui (de test lai tu dau)

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const TARGET_URL = process.env.TARGET_URL || 'https://www.minhngoc.net/kqxs/mien-bac.html';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LOCAL_TEST = process.env.LOCAL_TEST === '1';
const IGNORE_SENT_LOG = process.env.IGNORE_SENT_LOG === '1';

// So ngay toi da bo qua tinh tu "hom nay" (khong tinh hom nay): n-6 -> n-1 = 6 ngay
const DAYS_BACK = 6;
// File luu lai cac ngay da gui thanh cong, de lan sau khong gui lai
const SENT_LOG_PATH = path.join(process.cwd(), 'sent-log.json');
// Chi giu lai log trong X ngay gan nhat de file khong phinh to theo thoi gian
const KEEP_LOG_DAYS = 40;
// File anh ghep se luu khi chay o che do LOCAL_TEST
const DEBUG_OUTPUT_PATH = path.join(process.cwd(), 'debug-output.png');

if (!LOCAL_TEST && (!BOT_TOKEN || !CHAT_ID)) {
  console.error('Thieu TELEGRAM_BOT_TOKEN hoac TELEGRAM_CHAT_ID trong bien moi truong.');
  process.exit(1);
}

function loadSentLog() {
  if (IGNORE_SENT_LOG) return [];
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
  if (LOCAL_TEST) {
    console.log('[LOCAL_TEST] Bo qua gui text Telegram:', text);
    return;
  }
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

    // Chi ghep nhung ngay CHUA co trong sent-log
    const toProcess = targetDayKeys.filter((k) => !sentSet.has(k));

    if (toProcess.length === 0) {
      console.log('Tat ca cac ngay trong pham vi da duoc gui truoc do. Khong can chup lai.');
      return;
    }

    console.log('Cac ngay se ghep vao 1 anh:', toProcess.join(', '));

    // Ghep toan bo cac ngay trong toProcess thanh 1 khoi duy nhat trong trang (da loc quang cao),
    // roi chup 1 anh duy nhat cho khoi do.
    const shotInfo = await page.evaluate((keys) => {
      const AD_SELECTORS = [
        'script', 'style', 'iframe', 'ins', 'noscript', 'embed',
        '[id*="ads" i]', '[class*="ads" i]',
        '[id*="ad-" i]', '[class*="ad-" i]',
        '[id*="adv" i]', '[class*="adv" i]',
        '[id*="banner" i]', '[class*="banner" i]',
        '[id*="quangcao" i]', '[class*="quangcao" i]',
        '[id*="sponsor" i]', '[class*="sponsor" i]',
        '[id^="div-gpt-ad"]',
      ];

      function stripAds(root) {
        AD_SELECTORS.forEach((sel) => {
          try {
            root.querySelectorAll(sel).forEach((el) => el.remove());
          } catch (_) {
            /* selector khong ho tro tren trinh duyet nay, bo qua */
          }
        });
      }

      const elements = keys
        .map((k) => document.querySelector(`[data-mn-day="${k}"]`))
        .filter(Boolean);

      if (elements.length === 0) return null;

      // Sap xep lai theo vi tri hien tai tren trang (moi nhat o tren, cu nhat o duoi)
      elements.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

      const refWidth = elements[0].getBoundingClientRect().width || 520;

      const wrapper = document.createElement('div');
      wrapper.id = 'mn-combined-capture-wrapper';
      wrapper.style.background = '#ffffff';
      wrapper.style.width = `${Math.ceil(refWidth)}px`;
      wrapper.style.padding = '0';
      wrapper.style.margin = '24px 0 0 0';

      elements.forEach((el, idx) => {
        const clone = el.cloneNode(true);
        stripAds(clone);
        clone.style.marginBottom = idx < elements.length - 1 ? '18px' : '0';
        wrapper.appendChild(clone);
      });

      document.body.appendChild(wrapper);
      return { id: wrapper.id, count: elements.length };
    }, toProcess);

    if (!shotInfo) {
      console.warn('Khong ghep duoc anh: khong tim thay block nao khop voi cac ngay can xu ly.');
      return;
    }

    const wrapperHandle = await page.$(`#${shotInfo.id}`);
    const buffer = await wrapperHandle.screenshot({ type: 'png' });

    // Don dep khoi ghep tam sau khi da chup xong
    await page.evaluate((id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    }, shotInfo.id);

    // Sap xep lai toProcess theo thu tu thoi gian (cu -> moi) chi de lam caption cho de doc
    const chronological = [...toProcess].sort((a, b) => parseDdMmYyyy(a) - parseDdMmYyyy(b));
    const toDisplay = (key) => {
      const [d, m, y] = key.split('-');
      return `${d}/${m}/${y}`;
    };
    const caption =
      chronological.length === 1
        ? `Ket qua xo so - ${toDisplay(chronological[0])}`
        : `Ket qua xo so tu ${toDisplay(chronological[0])} den ${toDisplay(chronological[chronological.length - 1])}`;
    const filename = `ket-qua_ghep_${chronological[0]}_${chronological[chronological.length - 1]}.png`;

    if (LOCAL_TEST) {
      fs.writeFileSync(DEBUG_OUTPUT_PATH, buffer);
      console.log(`[LOCAL_TEST] Da luu anh ghep vao ${DEBUG_OUTPUT_PATH} (${shotInfo.count} ngay). Khong gui Telegram, khong ghi sent-log.json.`);
      return;
    }

    try {
      await sendDocumentToTelegram(buffer, filename, caption);
      console.log(`Da gui anh ghep (${shotInfo.count} ngay: ${toProcess.join(', ')}) qua Telegram thanh cong.`);
      saveSentLog([...sentSet, ...toProcess]);
      console.log('Da cap nhat sent-log.json.');
    } catch (err) {
      console.error('Loi khi gui anh ghep qua Telegram:', err);
      try {
        await sendTextToTelegram(`❌ Loi khi chup/gui anh ket qua ghep (${toProcess.join(', ')}): ${err.message}`);
      } catch (_) {}
      process.exit(1);
    }
  } finally {
    await browser.close();
  }
}

run();
