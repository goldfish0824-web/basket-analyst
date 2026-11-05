// 場面別Q&A の印刷用 PDF（A4 縦・両面・バインダー用）を作る。できあがりは print/qa.pdf。
//   node tools/make-qa-pdf.cjs
// アプリの印刷用ページ（#/qa/print）を Chromium（Playwright）で開いて PDF にする。
// 目次のページ番号を入れるため、先に場面ごとのページ数を数えてから、全体を作る。
// Q&A の中身（js/qa-data.js）を変えたら作り直す。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'print', 'qa.pdf');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function countPages(buf) {
  return (buf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
}

const FOOTER = `<div style="width:100%;font-size:7.5px;color:#555;font-family:'IPAPGothic','IPAGothic',sans-serif;padding:0 20mm;display:flex;justify-content:space-between;">
  <span>BasketBall Analyst　場面別Q&amp;A</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1180, height: 820 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const pdf = (extra = {}) => page.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: true, ...extra });
  const open = async (hash) => {
    await page.goto(`${base}#/qa/print${hash}`);
    await page.waitForSelector('.qp-item');
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => document.fonts.ready);
  };

  // 1. 場面ごとのページ数
  await open('');
  const entries = await page.$$eval('.qp-item', (els) => els.map((el) => ({ no: Number(el.dataset.no) })));
  const ids = await page.evaluate(async () => {
    const m = await import('/js/qa-print.js');
    return m.printPlan().flatMap((s) => s.items.map((e) => ({ no: e.no, id: e.id })));
  });
  const counts = {};
  for (const { no, id } of ids) {
    await open(`/${id}`);
    counts[no] = countPages(await pdf());
  }
  // 2. 表紙と目次のページ数（全体 − 場面の合計）。ページ番号を入れて作り直し、ずれなくなるまで
  let coverPages = 1;
  let buf = null;
  for (let round = 0; round < 3; round++) {
    const pages = {};
    let p = coverPages + 1;
    for (const { no } of ids) {
      pages[no] = p;
      p += counts[no];
    }
    // いったん一覧へ移ってからページ番号を渡し、印刷用ページを描き直す（同じ文書の中で移るので値は残る）
    await page.goto(`${base}#/qa`);
    await page.evaluate((v) => { window.__qaPrintPages = v; }, pages);
    await open('');
    buf = await pdf({ displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: FOOTER });
    const total = countPages(buf);
    const items = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total - items === coverPages) break;
    coverPages = total - items;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buf);
  console.log(JSON.stringify({ out: path.relative(ROOT, OUT), pages: countPages(buf), coverPages, items: entries.length, errors }));
  await browser.close();
  server.close();
})();
