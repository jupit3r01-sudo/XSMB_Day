// capture.js
// Mo trang minhngoc.net, tim khoi ket qua xo so (tuong tu logic trong userscript goc),
// chup anh vung do, roi gui qua Telegram bang Bot API.
//
// Bien moi truong can co (dat trong GitHub Secrets):
//   TELEGRAM_BOT_TOKEN  - token cua bot Telegram (lay tu @BotFather)
//   TELEGRAM_CHAT_ID    - id cua chat/nguoi nhan
//   TARGET_URL          - (tuy chon) URL trang ket qua muon chup, mac dinh la mien Bac

const puppeteer = require('puppeteer');

const TARGET_URL =
  process.env.TARGET_URL || 'https://www.minhngoc.net/ket-qua-xo-so/mien-bac.html';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Thieu TELEGRAM_BOT_TOKEN hoac TELEGRAM_CHAT_ID trong bien moi truong.');
  process.exit(1);
}

// Gui anh (buffer) qua Telegram Bot API
async function sendPhotoToTelegram(buffer, caption) {
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('caption', caption);
  form.append('photo', new Blob([buffer], { type: 'image/png' }), 'ket-qua.png');

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error('Telegram tra ve loi: ' + JSON.stringify(data));
  }
  return data;
}

// Gui tin nhan text bao loi (de biet job co chay nhung khong tim thay khoi ket qua)
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
    await page.setViewport({ width: 1280, height: 1600 });
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Cho chac chan bang ket qua da render xong
    await page.waitForSelector('body');
    await new Promise((r) => setTimeout(r, 2000));

    // Chay logic tim khoi ket qua ngay trong trang, giong userscript goc,
    // roi gan attribute de lay elementHandle ra ngoai.
    const found = await page.evaluate(() => {
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

      function findCommonAncestor(elements) {
        if (!elements || elements.length === 0) return null;
        let ancestor = elements[0];
        for (let i = 1; i < elements.length; i++) {
          while (ancestor && !ancestor.contains(elements[i])) {
            ancestor = ancestor.parentElement;
          }
        }
        return ancestor;
      }

      const blocks = findResultBlocks();
      if (blocks.length === 0) return false;

      const sorted = blocks.slice().sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.top - rb.top;
      });

      const container = findCommonAncestor(sorted);
      if (!container) return false;

      container.setAttribute('data-mn-capture-target', '1');
      return true;
    });

    if (!found) {
      await sendTextToTelegram(
        '⚠️ Khong tim thay khoi ket qua xo so tren trang. Trang co the da doi cau truc, can kiem tra lai script.'
      );
      process.exit(1);
    }

    const el = await page.$('[data-mn-capture-target="1"]');
    if (!el) {
      await sendTextToTelegram('⚠️ Da tim thay khoi nhung khong lay duoc elementHandle de chup.');
      process.exit(1);
    }

    const buffer = await el.screenshot({ type: 'png' });

    const now = new Date();
    const vnTime = new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(now);

    await sendPhotoToTelegram(buffer, `Ket qua xo so - ${vnTime}`);
    console.log('Da gui anh qua Telegram thanh cong.');
  } catch (err) {
    console.error('Loi:', err);
    try {
      await sendTextToTelegram('❌ Loi khi chup/gui anh ket qua xo so: ' + err.message);
    } catch (_) {}
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();
