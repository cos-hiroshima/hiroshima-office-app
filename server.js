const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const https    = require('https');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'hiroshima-2026-secret';
const GH_TOKEN  = process.env.GH_TOKEN;
const GH_REPO   = process.env.GH_REPO || 'cos-hiroshima/hiroshima-office-app';
const GH_BRANCH = 'data';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { maxAge: 8*60*60*1000, httpOnly: true, secure: process.env.NODE_ENV==='production' }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ─── GitHub API ────────────────────────────────────────
const shas = {};

function ghReq(method, p, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path: p, method,
      headers: {
        'Authorization': `token ${GH_TOKEN}`,
        'User-Agent': 'hiroshima-app', 'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        ...(data ? {'Content-Length': Buffer.byteLength(data)} : {})
      }
    }, r => {
      let buf = '';
      r.on('data', d => buf += d);
      r.on('end', () => { try { res(JSON.parse(buf)); } catch { res(buf); } });
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

async function ghRead(file) {
  const r = await ghReq('GET', `/repos/${GH_REPO}/contents/data/${file}?ref=${GH_BRANCH}`);
  if (r.message) return null;
  shas[file] = r.sha;
  return JSON.parse(Buffer.from(r.content, 'base64').toString());
}

async function ghWrite(file, data) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const r = await ghReq('PUT', `/repos/${GH_REPO}/contents/data/${file}`, {
    message: `update ${file}`, content, branch: GH_BRANCH,
    ...(shas[file] ? { sha: shas[file] } : {})
  });
  if (r.content) shas[file] = r.content.sha;
  return r;
}

// ─── ミドルウェア ────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.empId) return next();
  res.status(401).json({ error: 'ログインが必要です' });
}
function requireAdmin(req, res, next) {
  if (req.session?.role === 'admin') return next();
  res.status(403).json({ error: '管理者権限が必要です' });
}
function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '';
}
async function addLog(empId, empName, action, target, detail, ip) {
  try {
    const logs = await ghRead('audit_log.json') || [];
    logs.unshift({ id: uuidv4(), emp_id: empId||'system', emp_name: empName||'system',
      action, target: target||'', detail: detail||'', ip: ip||'',
      created_at: new Date().toISOString().replace('T',' ').slice(0,19) });
    if (logs.length > 500) logs.splice(500);
    await ghWrite('audit_log.json', logs);
  } catch(e) { console.error('log error:', e.message); }
}
function now() { return new Date().toISOString().replace('T',' ').slice(0,19); }

// ─── 認証 API ──────────────────────────────────────
app.get('/api/auth/me', (req, res) => {
  if (!req.session?.empId) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, emp: { id: req.session.empId, name: req.session.empName, role: req.session.role }, mustChange: req.session.mustChange });
});

app.post('/api/auth/check', async (req, res) => {
  const { empId } = req.body;
  const emps = await ghRead('employees.json') || [];
  const emp = emps.find(e => e.id === empId);
  if (!emp || emp.status === '退職') return res.json({ exists: false });
  const auths = await ghRead('auth.json') || [];
  const auth = auths.find(a => a.emp_id === empId);
  if (!auth) return res.json({ exists: false });
  res.json({ exists: true, needsSetup: !auth.password_hash, name: emp.name });
});

app.post('/api/auth/setup', async (req, res) => {
  const { empId, password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'パスワードは8文字以上で設定してください' });
  const auths = await ghRead('auth.json') || [];
  const idx = auths.findIndex(a => a.emp_id === empId);
  if (idx === -1) return res.status(404).json({ error: '社員が見つかりません' });
  if (auths[idx].password_hash) return res.status(400).json({ error: 'すでにパスワードが設定されています' });
  auths[idx].password_hash = bcrypt.hashSync(password, 12);
  auths[idx].must_change = 0;
  await ghWrite('auth.json', auths);
  addLog(empId, null, 'SETUP_PASSWORD', 'auth', '初回パスワード設定', clientIp(req));
  res.json({ ok: true });
});

app.post('/api/auth/login', async (req, res) => {
  const { empId, password } = req.body;
  const emps = await ghRead('employees.json') || [];
  const emp = emps.find(e => e.id === empId);
  if (!emp || emp.status === '退職') return res.status(401).json({ error: 'IDまたはパスワードが違います' });
  const auths = await ghRead('auth.json') || [];
  const auth = auths.find(a => a.emp_id === empId);
  if (!auth || !auth.password_hash) return res.status(401).json({ error: '初回パスワード設定が必要です' });
  if (!bcrypt.compareSync(password, auth.password_hash)) return res.status(401).json({ error: 'IDまたはパスワードが違います' });
  auth.last_login = now();
  await ghWrite('auth.json', auths);
  req.session.empId = emp.id; req.session.empName = emp.name;
  req.session.role = emp.role; req.session.mustChange = !!auth.must_change;
  addLog(emp.id, emp.name, 'LOGIN', 'auth', 'ログイン成功', clientIp(req));
  res.json({ ok: true, emp, mustChange: !!auth.must_change });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  addLog(req.session.empId, req.session.empName, 'LOGOUT', 'auth', '', clientIp(req));
  req.session.destroy(() => res.json({ ok: true }));
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'パスワードは8文字以上で設定してください' });
  const auths = await ghRead('auth.json') || [];
  const auth = auths.find(a => a.emp_id === req.session.empId);
  if (!bcrypt.compareSync(currentPassword, auth.password_hash)) return res.status(401).json({ error: '現在のパスワードが違います' });
  auth.password_hash = bcrypt.hashSync(newPassword, 12); auth.must_change = 0;
  await ghWrite('auth.json', auths);
  req.session.mustChange = false;
  addLog(req.session.empId, req.session.empName, 'CHANGE_PASSWORD', 'auth', '', clientIp(req));
  res.json({ ok: true });
});

app.post('/api/auth/reset/:id', requireAuth, requireAdmin, async (req, res) => {
  const auths = await ghRead('auth.json') || [];
  const auth = auths.find(a => a.emp_id === req.params.id);
  if (!auth) return res.status(404).json({ error: '社員が見つかりません' });
  auth.password_hash = null; auth.must_change = 1;
  await ghWrite('auth.json', auths);
  addLog(req.session.empId, req.session.empName, 'RESET_PASSWORD', req.params.id, 'パスワードリセット', clientIp(req));
  res.json({ ok: true });
});

// ─── 社員マスタ ──────────────────────────────────────
app.get('/api/employees', requireAuth, async (req, res) => {
  const emps = await ghRead('employees.json') || [];
  const auths = await ghRead('auth.json') || [];
  const result = emps.map(e => {
    const a = auths.find(a => a.emp_id === e.id) || {};
    return { ...e, has_password: !!a.password_hash ? 1 : 0, last_login: a.last_login || null };
  }).sort((a,b) => {
    const order = {在籍:0,休職:1,退職:2};
    return (order[a.status]||9)-(order[b.status]||9) || a.name.localeCompare(b.name,'ja');
  });
  res.json(result);
});

app.post('/api/employees', requireAuth, requireAdmin, async (req, res) => {
  const emps = await ghRead('employees.json') || [];
  const auths = await ghRead('auth.json') || [];
  const id = 'emp' + Date.now();
  const { name, name_kana='', emp_type='社員', status='在籍', role='member',
          email='', remote_ok=1, client_site=0, join_date='', note='' } = req.body;
  if (!name) return res.status(400).json({ error: '氏名は必須です' });
  const n = now();
  const newEmp = { id, name, name_kana, emp_type, status, role, email,
    remote_ok: remote_ok?1:0, client_site: client_site?1:0, join_date, note,
    created_at: n, updated_at: n };
  emps.push(newEmp);
  auths.push({ emp_id: id, password_hash: null, must_change: 1, last_login: null });
  await Promise.all([ghWrite('employees.json', emps), ghWrite('auth.json', auths)]);
  addLog(req.session.empId, req.session.empName, 'ADD_EMPLOYEE', id, `${name}を追加`, clientIp(req));
  res.json({ ...newEmp, has_password: 0, last_login: null });
});

app.put('/api/employees/:id', requireAuth, requireAdmin, async (req, res) => {
  const emps = await ghRead('employees.json') || [];
  const idx = emps.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '社員が見つかりません' });
  const { name, name_kana, emp_type, status, role, email, remote_ok, client_site, join_date, note } = req.body;
  emps[idx] = { ...emps[idx], name, name_kana, emp_type, status, role, email: email||'',
    remote_ok: remote_ok?1:0, client_site: client_site?1:0, join_date, note, updated_at: now() };
  await ghWrite('employees.json', emps);
  addLog(req.session.empId, req.session.empName, 'EDIT_EMPLOYEE', req.params.id, `${name}を更新`, clientIp(req));
  res.json(emps[idx]);
});

app.delete('/api/employees/:id', requireAuth, requireAdmin, async (req, res) => {
  let emps = await ghRead('employees.json') || [];
  let auths = await ghRead('auth.json') || [];
  const emp = emps.find(e => e.id === req.params.id);
  if (!emp) return res.status(404).json({ error: '社員が見つかりません' });
  emps = emps.filter(e => e.id !== req.params.id);
  auths = auths.filter(a => a.emp_id !== req.params.id);
  await Promise.all([ghWrite('employees.json', emps), ghWrite('auth.json', auths)]);
  addLog(req.session.empId, req.session.empName, 'DELETE_EMPLOYEE', req.params.id, `${emp.name}を削除`, clientIp(req));
  res.json({ ok: true });
});

// ─── 業務タスク ──────────────────────────────────────
app.get('/api/tasks', requireAuth, async (req, res) => {
  const tasks = await ghRead('tasks.json') || [];
  const emps = await ghRead('employees.json') || [];
  const empMap = Object.fromEntries(emps.map(e => [e.id, e.name]));
  const order = {高:0,中:1,低:2};
  res.json(tasks.sort((a,b)=>(order[a.priority]||9)-(order[b.priority]||9))
    .map(t => ({ ...t, assignee_name: empMap[t.assignee_id]||null, sub_assignee_name: empMap[t.sub_assignee_id]||null })));
});

app.post('/api/tasks', requireAuth, async (req, res) => {
  const tasks = await ghRead('tasks.json') || [];
  const { category='', title, description='', priority='中', rotation_type='fixed',
          assignee_id=null, sub_assignee_id=null, status='担当未定', frequency='随時', note='' } = req.body;
  if (!title) return res.status(400).json({ error: '業務名は必須です' });
  const n = now();
  const t = { id: 'task'+Date.now(), category, title, description, priority, rotation_type,
    assignee_id: assignee_id||null, sub_assignee_id: sub_assignee_id||null, status, frequency, note,
    created_at: n, updated_at: n };
  tasks.push(t);
  await ghWrite('tasks.json', tasks);
  addLog(req.session.empId, req.session.empName, 'ADD_TASK', t.id, `「${title}」を追加`, clientIp(req));
  res.json(t);
});

app.put('/api/tasks/:id', requireAuth, async (req, res) => {
  const tasks = await ghRead('tasks.json') || [];
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '業務が見つかりません' });
  const old = tasks[idx];
  const { category, title, description, priority, rotation_type,
          assignee_id, sub_assignee_id, status, frequency, note } = req.body;
  tasks[idx] = { ...old, category, title, description, priority, rotation_type,
    assignee_id: assignee_id||null, sub_assignee_id: sub_assignee_id||null,
    status, frequency, note, updated_at: now() };
  await ghWrite('tasks.json', tasks);
  if (old.assignee_id !== (assignee_id||null)) {
    const emps = await ghRead('employees.json') || [];
    const nm = assignee_id ? (emps.find(e=>e.id===assignee_id)?.name||'') : '未設定';
    addLog(req.session.empId, req.session.empName, 'ASSIGN_TASK', req.params.id, `「${title}」主担当→${nm}`, clientIp(req));
  } else {
    addLog(req.session.empId, req.session.empName, 'EDIT_TASK', req.params.id, `「${title}」を更新`, clientIp(req));
  }
  res.json(tasks[idx]);
});

app.delete('/api/tasks/:id', requireAuth, requireAdmin, async (req, res) => {
  let tasks = await ghRead('tasks.json') || [];
  const t = tasks.find(t => t.id === req.params.id);
  tasks = tasks.filter(t => t.id !== req.params.id);
  await ghWrite('tasks.json', tasks);
  addLog(req.session.empId, req.session.empName, 'DELETE_TASK', req.params.id, `「${t?.title}」を削除`, clientIp(req));
  res.json({ ok: true });
});

// ─── 出社予定 ────────────────────────────────────────
app.get('/api/attendance/:ym', requireAuth, async (req, res) => {
  const all = await ghRead('attendance.json') || {};
  res.json(all[req.params.ym] || {});
});

app.put('/api/attendance/:ym/:empId/:day', requireAuth, async (req, res) => {
  const { ym, empId, day } = req.params; const { status } = req.body;
  const all = await ghRead('attendance.json') || {};
  if (!all[ym]) all[ym] = {};
  if (!all[ym][empId]) all[ym][empId] = {};
  all[ym][empId][parseInt(day)] = status;
  await ghWrite('attendance.json', all);
  const emps = await ghRead('employees.json') || [];
  const nm = emps.find(e=>e.id===empId)?.name || empId;
  addLog(req.session.empId, req.session.empName, 'EDIT_ATTENDANCE', empId, `${nm} ${ym}/${day}→${status}`, clientIp(req));
  res.json({ ok: true });
});

// ─── 操作ログ ─────────────────────────────────────────
app.get('/api/logs', requireAuth, requireAdmin, async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = await ghRead('audit_log.json') || [];
  res.json(logs.slice(0, limit));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n✅ 広島オフィス管理システム v3 起動中 (GitHub storage)`);
  console.log(`   http://localhost:${PORT}\n`);
  if (!GH_TOKEN) console.warn('⚠️  GH_TOKEN が未設定です');
});
