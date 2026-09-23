// capture.js
// Mo trang minhngoc.net (hien thi cac ngay gan nhat: tu ngay moi nhat tro ve truoc).
// Lay day du header do + bang ket qua, ghep thanh 1 anh dai DUY NHAT roi gui qua Telegram.
//
// Bien moi truong can co (dat trong GitHub Secrets):
//   TELEGRAM_BOT_TOKEN  - token cua bot Telegram (lay tu @BotFather)
//   TELEGRAM_CHAT_ID    - id cua chat/nguoi nhan
//   TARGET_URL          - (tuy chon) URL trang ket qua, mac dinh la mien Bac
//
// Bien moi truong CHI DUNG DE TEST:
//   LOCAL_TEST=1        - luu anh ghep ra file local (./debug-output.png)
//   IGNORE_SENT_LOG=1   - bo qua sent-log.json, coi nhu chua ngay nao duoc gui

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const TARGET_URL = process.env.TARGET_URL || 'https://www.minhngoc.net/kqxs/mien-bac.html';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LOCAL_TEST = process.env.LOCAL_TEST === '1';
const IGNORE_SENT_LOG = process.env.IGNORE_SENT_LOG === '1';

// So luong ngay can chup ghep (7 ngay: tu 22 xuong 16/15 nhu anh mau)
const TOTAL_DAYS = 7;
const SENT_LOG_PATH = path.join(process.cwd(), 'sent-log.json');
const KEEP_LOG_DAYS = 40;
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
    // Tang deviceScaleFactor len 2 de chat luong anh sac net nhu html2canvas scale 2
    await page.setViewport({ width: 1280, height: 2000, deviceScaleFactor: 2 });
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    await page.waitForSelector('body');
    try {
      await page.evaluate(() => document.fonts && document.fonts.ready);
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 2000));

    // Tim dung khoi bao gom ca Header do va bang so
    const dayKeysNewestFirst = await page.evaluate(() => {
      function normText(s) {
        return (s || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
      }

      let blocks = Array.from(document.querySelectorAll('.box_kqxs, .content-box, div[class*="box_kq"]'));

      if (blocks.length === 0) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node;
        const headers = [];
        while ((node = walker.nextNode())) {
          const t = normText(node.textContent);
          if (/KẾT QUẢ XỔ SỐ/i.test(t)) {
            headers.push(node.parentElement);
          }
        }
        blocks = headers.map((h) => h.closest('.box, table, div[class*="content"]') || h.parentElement);
      }

      const unique = [];
      blocks.forEach((el) => {
        if (el && !unique.includes(el) && el.innerText.includes('Giải ĐB')) {
          unique.push(el);
        }
      });

      const validBlocks = unique
        .filter((el) => !unique.some((other) => other !== el && el.contains(other)))
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

      const dayKeys = [];
      validBlocks.forEach((block) => {
        const txt = block.innerText || '';
        const m = txt.match(/Ngày:\s*(\d{2})\/(\d{2})\/(\d{4})/);
        if (m) {
          const key = `${m[1]}-${m[2]}-${m[3]}`;
          block.setAttribute('data-mn-day', key);
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

    // Lay tu ngay dau tien (index 0, ngay 22) xuong cac ngay tiep theo
    const targetDayKeys = dayKeysNewestFirst.slice(0, TOTAL_DAYS);

    const sentDates = loadSentLog();
    const sentSet = new Set(sentDates);

    // Neu khong dung che do LOCAL_TEST, loc bo nhung ngay da gui
    const toProcess = LOCAL_TEST ? targetDayKeys : targetDayKeys.filter((k) => !sentSet.has(k));

    if (toProcess.length === 0) {
      console.log('Tat ca cac ngay can chup da duoc gui truoc do.');
      return;
    }

    console.log('Cac ngay se ghep vao 1 anh:', toProcess.join(', '));

    // Tao wrapper tam de ghep cac khoi (da loc sach quang cao)
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
          } catch (_) {}
        });
      }

      const elements = keys
        .map((k) => document.querySelector(`[data-mn-day="${k}"]`))
        .filter(Boolean);

      if (elements.length === 0) return null;

      elements.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

      const refWidth = elements[0].getBoundingClientRect().width || 560;

      const wrapper = document.createElement('div');
      wrapper.id = 'mn-combined-capture-wrapper';
      wrapper.style.background = '#ffffff';
      wrapper.style.width = `${Math.ceil(refWidth)}px`;
      wrapper.style.padding = '0';
      wrapper.style.margin = '20px auto';

      elements.forEach((el, idx) => {
        const clone = el.cloneNode(true);
        stripAds(clone);
        clone.style.margin = '0 auto';
        clone.style.marginBottom = idx < elements.length - 1 ? '18px' : '0';
        clone.style.width = '100%';
        wrapper.appendChild(clone);
      });

      document.body.appendChild(wrapper);
      return { id: wrapper.id, count: elements.length };
    }, toProcess);

    if (!shotInfo) {
      console.warn('Khong tim thay block tuong ung de ghep.');
      return;
    }

    const wrapperHandle = await page.$(`#${shotInfo.id}`);
    const buffer = await wrapperHandle.screenshot({ type: 'png' });

    // Xoa wrapper tam
    await page.evaluate((id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    }, shotInfo.id);

    const chronological = [...toProcess].sort((a, b) => parseDdMmYyyy(a) - parseDdMmYyyy(b));
    const toDisplay = (key) => {
      const [d, m, y] = key.split('-');
      return `${d}/${m}/${y}`;
    };
    const caption =
      chronological.length === 1
        ? `Kết quả xổ số - ${toDisplay(chronological[0])}`
        : `Kết quả xổ số từ ${toDisplay(chronological[0])} đến ${toDisplay(chronological[chronological.length - 1])}`;
    const filename = `KQXS_${chronological[0]}_${chronological[chronological.length - 1]}.png`;

    if (LOCAL_TEST) {
      fs.writeFileSync(DEBUG_OUTPUT_PATH, buffer);
      console.log(`[LOCAL_TEST] Da luu anh vao ${DEBUG_OUTPUT_PATH} (${shotInfo.count} ngay).`);
      return;
    }

    try {
      await sendDocumentToTelegram(buffer, filename, caption);
      console.log(`Da gui anh ghep (${shotInfo.count} ngay) qua Telegram thanh cong.`);
      saveSentLog([...sentSet, ...toProcess]);
    } catch (err) {
      console.error('Loi khi gui Telegram:', err);
      try {
        await sendTextToTelegram(`❌ Loi khi chup/gui anh: ${err.message}`);
      } catch (_) {}
      process.exit(1);
    }
  } finally {
    await browser.close();
  }
}

run();
