const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4400;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');

const STATIC_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
function sendJSON(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', (c) => { chunks += c; if (chunks.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!chunks) return resolve({});
      try { resolve(JSON.parse(chunks)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function csvEscape(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, keys, handler });
}

route('GET', '/api/data', (req, res) => {
  sendJSON(res, 200, readData());
});

route('GET', '/api/reimbursements/export', (req, res) => {
  const data = readData();
  const rows = [['Description', 'Date', 'Category', 'Amount', 'Status']]
    .concat(data.reimbursements.map((r) => [r.name, r.date, r.category, r.amount.toFixed(2), r.status]));
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv',
    'Content-Disposition': 'attachment; filename="reimbursements-september-2026.csv"',
  });
  res.end(csv);
});

route('POST', '/api/split-bills/:id/remind', (req, res, params) => {
  const data = readData();
  const bill = data.splitBills.find((b) => b.id === params.id);
  if (!bill) return sendJSON(res, 404, { error: 'Bill not found' });
  bill.lastReminded = new Date().toISOString();
  writeData(data);
  sendJSON(res, 200, bill);
});

route('POST', '/api/split-bills/:id/pay', (req, res, params) => {
  const data = readData();
  const bill = data.splitBills.find((b) => b.id === params.id);
  if (!bill) return sendJSON(res, 404, { error: 'Bill not found' });
  if (bill.direction !== 'owe') return sendJSON(res, 400, { error: 'This bill is not something you owe' });
  bill.paid = true;
  writeData(data);
  sendJSON(res, 200, bill);
});

route('POST', '/api/returns/:id/start', (req, res, params) => {
  const data = readData();
  const ret = data.returns.find((r) => r.id === params.id);
  if (!ret) return sendJSON(res, 404, { error: 'Return not found' });
  ret.returnStatus = 'in_progress';
  writeData(data);
  sendJSON(res, 200, ret);
});

route('POST', '/api/rewards/:id/redeem', async (req, res, params) => {
  const data = readData();
  const reward = data.rewards.find((r) => r.id === params.id);
  if (!reward) return sendJSON(res, 404, { error: 'Reward not found' });
  if (reward.redeemed) return sendJSON(res, 400, { error: 'Already redeemed' });
  if (reward.have < reward.cost) return sendJSON(res, 400, { error: 'Not enough points yet' });
  reward.redeemed = true;
  const card = data.loyalty.find((l) => l.id === reward.loyaltyId);
  if (card && typeof card.points === 'number') card.points -= reward.cost;
  writeData(data);
  sendJSON(res, 200, { reward, loyalty: card || null });
});

route('POST', '/api/receipts', async (req, res, params, body) => {
  const data = readData();
  const id = 'manual-' + Date.now();
  const txn = {
    id,
    store: body.store || 'New receipt',
    category: body.category || 'Uncategorized',
    date: data.meta.month.split(' ')[0].slice(0, 3) + ' ' + new Date().getDate() + ', 2026',
    kind: 'icon', glyph: 'plus', color: '#6A6A72',
    payment: body.payment || 'Not specified',
    total: Number(body.total) || 0,
    items: body.items && body.items.length ? body.items : [{ n: 'Uncategorized item', q: '', p: Number(body.total) || 0 }],
  };
  data.transactions.unshift(txn);
  data.inbox.newReceipts = Math.max(0, data.inbox.newReceipts - 1);
  writeData(data);
  sendJSON(res, 201, txn);
});

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = urlPath.match(r.regex);
    if (!match) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = match[i + 1]; });
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      return r.handler(req, res, params, body);
    } catch (e) {
      return sendJSON(res, 400, { error: 'Invalid request body' });
    }
  }

  if (urlPath.startsWith('/api/')) return sendJSON(res, 404, { error: 'Not found' });

  let filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Receitly dashboard running at http://localhost:${PORT}`));
