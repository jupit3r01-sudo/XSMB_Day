// XSMB.js
// Chup tung ngay theo khung hinh chuan (clip bounding box), sau do dung sharp ghep thanh 1 anh dai.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const sharp = require('sharp');

const TARGET_URL = process.env.TARGET_URL || 'https://www.minhngoc.net/kqxs/mien-bac.html';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LOCAL_TEST = process.env.LOCAL_TEST === '1';
const IGNORE_SENT_LOG = process.env.IGNORE_SENT_LOG === '1';

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
    await page.setViewport({ width: 1280, height: 2600, deviceScaleFactor: 2 });
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    await page.waitForSelector('body');
    try {
      await page.evaluate(() => document.fonts && document.fonts.ready);
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 2000));

    // 1. An triet de toan bo bang Loto (Chuc - So - D.Vi) va cac tien ich thua tren DOM goc
    await page.evaluate(() => {
      // An tat ca cac phan tu lien quan toi loto / chuc / d.vi
      const allEls = document.querySelectorAll('*');
      allEls.forEach((el) => {
        const txt = (el.innerText || '').replace(/\s+/g, ' ');
        if (txt.includes('Chục') && txt.includes('Đ.Vị')) {
          const container = el.closest('table, div, td');
          if (container && !container.innerText.includes('Giải ĐB')) {
            container.style.display = 'none';
          }
        }
      });

      // An cac thanh tien ich nut bam
      document.querySelectorAll('.sub-title, .tools, .buttons, a[href*="in-ve-do"], div[class*="tool"]').forEach((el) => {
        el.style.display = 'none';
      });
    });

    // 2. Do toa do chuan: Width lay theo dong Giai bay, Height tu dinh .bkm den day Giai bay
    const blocksData = await page.evaluate(() => {
      const bkmList = Array.from(document.querySelectorAll('.bkm'));
      const results = [];

      bkmList.forEach((bkm) => {
        const txt = bkm.innerText || '';
        const m = txt.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
        if (!m) return;
        const key = `${m[1]}-${m[2]}-${m[3]}`;

        const parent = bkm.closest('.box_kqxs, .content-box, div[class*="box"]') || bkm.parentElement;
        const mainTable = parent.querySelector('table.bkqmienbac') || parent.querySelector('table');
        if (!mainTable) return;

        const rows = Array.from(mainTable.querySelectorAll('tr'));
        const rowGiaiBay = rows.find((r) => (r.innerText || '').includes('Giải bảy'));
        if (!rowGiaiBay) return;

        const bkmRect = bkm.getBoundingClientRect();
        const bayRect = rowGiaiBay.getBoundingClientRect();

        // Chieu rong lay theo dong Giai bay (chuan xac theo mep bang, khong vuot sang cot loto)
        const x = window.scrollX + bayRect.left;
        const y = window.scrollY + bkmRect.top;
        const width = bayRect.width;
        const height = bayRect.bottom - bkmRect.top;

        results.push({
          key,
          clip: { x, y, width, height }
        });
      });

      return results;
    });

    if (blocksData.length === 0) {
      await sendTextToTelegram('⚠️ Khong xac dinh duoc toa do cac khung ket qua tren trang.');
      process.exit(1);
    }

    const targetBlocks = blocksData.slice(0, TOTAL_DAYS);
    const sentDates = loadSentLog();
    const sentSet = new Set(sentDates);

    const toProcess = LOCAL_TEST ? targetBlocks : targetBlocks.filter((b) => !sentSet.has(b.key));

    if (toProcess.length === 0) {
      console.log('Tat ca cac ngay can chup da duoc gui truoc do.');
      return;
    }

    console.log('Chup rieng tung ngay:', toProcess.map((b) => b.key).join(', '));

    // Chup anh tung block
    const dayBuffers = [];
    for (const item of toProcess) {
      const buf = await page.screenshot({
        type: 'png',
        clip: item.clip,
      });
      dayBuffers.push(buf);
    }

    console.log(`Da chup xong ${dayBuffers.length} anh. Dang ghep bang sharp...`);

    // Ghep bang sharp
    const imagesMeta = await Promise.all(dayBuffers.map((buf) => sharp(buf).metadata()));

    const SPACING = 16;
    const maxWidth = Math.max(...imagesMeta.map((m) => m.width));
    const totalHeight = imagesMeta.reduce((sum, m) => sum + m.height, 0) + SPACING * (dayBuffers.length - 1);

    let currentTop = 0;
    const compositeList = [];

    for (let i = 0; i < dayBuffers.length; i++) {
      compositeList.push({
        input: dayBuffers[i],
        top: currentTop,
        left: 0,
      });
      currentTop += imagesMeta[i].height + SPACING;
    }

    const combinedBuffer = await sharp({
      create: {
        width: maxWidth,
        height: totalHeight,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .composite(compositeList)
      .png()
      .toBuffer();

    const chronological = toProcess.map((b) => b.key).sort((a, b) => parseDdMmYyyy(a) - parseDdMmYyyy(b));
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
      fs.writeFileSync(DEBUG_OUTPUT_PATH, combinedBuffer);
      console.log(`[LOCAL_TEST] Da ghep thanh cong ${toProcess.length} ngay vao ${DEBUG_OUTPUT_PATH}.`);
      return;
    }

    try {
      await sendDocumentToTelegram(combinedBuffer, filename, caption);
      console.log(`Da gui anh ghep (${toProcess.length} ngay) qua Telegram thanh cong.`);
      saveSentLog([...sentSet, ...toProcess.map((b) => b.key)]);
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
