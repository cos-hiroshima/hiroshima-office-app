const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const { init, now } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3001;
const SESSION_SECRET = process.env.SESSION_SECRET || 'hiroshima-2026-secret';

let D; // DB helper

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { maxAge: 8*60*60*1000, httpOnly: true, secure: process.env.NODE_ENV==='production' }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req,res,next){ if(req.session?.empId) return next(); res.status(401).json({error:'ログインが必要です'}); }
function requireAdmin(req,res,next){ if(req.session?.role==='admin') return next(); res.status(403).json({error:'管理者権限が必要です'}); }
function ip(req){ return req.headers['x-forwarded-for']?.split(',')[0]||req.socket.remoteAddress||''; }

// ── 認証 ──────────────────────────────────────────────
app.get('/api/auth/me',(req,res)=>{
  if(!req.session?.empId) return res.json({loggedIn:false});
  const emp=D.get('SELECT id,name,emp_type,role,status FROM employees WHERE id=?',[req.session.empId]);
  res.json({loggedIn:true,emp,mustChange:req.session.mustChange});
});

app.post('/api/auth/check',async(req,res)=>{
  const {empId}=req.body;
  const emp=D.get('SELECT id,name,status FROM employees WHERE id=?',[empId]);
  if(!emp||emp.status==='退職') return res.json({exists:false});
  const auth=D.get('SELECT password_hash,must_change FROM auth WHERE emp_id=?',[empId]);
  if(!auth) return res.json({exists:false});
  res.json({exists:true,needsSetup:!auth.password_hash,name:emp.name});
});

app.post('/api/auth/setup',async(req,res)=>{
  const {empId,password}=req.body;
  if(!password||password.length<8) return res.status(400).json({error:'パスワードは8文字以上で設定してください'});
  const auth=D.get('SELECT password_hash FROM auth WHERE emp_id=?',[empId]);
  if(!auth) return res.status(404).json({error:'社員が見つかりません'});
  if(auth.password_hash) return res.status(400).json({error:'すでにパスワードが設定されています'});
  const hash=bcrypt.hashSync(password,12);
  D.run('UPDATE auth SET password_hash=?,must_change=0 WHERE emp_id=?',[hash,empId]);
  D.save();
  D.log(empId,null,'SETUP_PASSWORD','auth','初回パスワード設定',ip(req));
  res.json({ok:true});
});

app.post('/api/auth/login',async(req,res)=>{
  const {empId,password}=req.body;
  const emp=D.get('SELECT id,name,emp_type,role,status FROM employees WHERE id=?',[empId]);
  if(!emp||emp.status==='退職') return res.status(401).json({error:'IDまたはパスワードが違います'});
  const auth=D.get('SELECT password_hash,must_change FROM auth WHERE emp_id=?',[empId]);
  if(!auth||!auth.password_hash) return res.status(401).json({error:'初回パスワード設定が必要です'});
  if(!bcrypt.compareSync(password,auth.password_hash)) return res.status(401).json({error:'IDまたはパスワードが違います'});
  D.run('UPDATE auth SET last_login=? WHERE emp_id=?',[now(),empId]);
  D.save();
  req.session.empId=emp.id; req.session.empName=emp.name;
  req.session.role=emp.role; req.session.mustChange=!!auth.must_change;
  D.log(emp.id,emp.name,'LOGIN','auth','ログイン成功',ip(req));
  res.json({ok:true,emp,mustChange:!!auth.must_change});
});

app.post('/api/auth/logout',requireAuth,(req,res)=>{
  D.log(req.session.empId,req.session.empName,'LOGOUT','auth','',ip(req));
  req.session.destroy(()=>res.json({ok:true}));
});

app.post('/api/auth/change-password',requireAuth,(req,res)=>{
  const {currentPassword,newPassword}=req.body;
  if(!newPassword||newPassword.length<8) return res.status(400).json({error:'パスワードは8文字以上で設定してください'});
  const auth=D.get('SELECT password_hash FROM auth WHERE emp_id=?',[req.session.empId]);
  if(!bcrypt.compareSync(currentPassword,auth.password_hash)) return res.status(401).json({error:'現在のパスワードが違います'});
  D.run('UPDATE auth SET password_hash=?,must_change=0 WHERE emp_id=?',[bcrypt.hashSync(newPassword,12),req.session.empId]);
  D.save();
  req.session.mustChange=false;
  D.log(req.session.empId,req.session.empName,'CHANGE_PASSWORD','auth','',ip(req));
  res.json({ok:true});
});

app.post('/api/auth/reset/:id',requireAuth,requireAdmin,(req,res)=>{
  const t=D.get('SELECT name FROM employees WHERE id=?',[req.params.id]);
  if(!t) return res.status(404).json({error:'社員が見つかりません'});
  D.run('UPDATE auth SET password_hash=NULL,must_change=1 WHERE emp_id=?',[req.params.id]);
  D.save();
  D.log(req.session.empId,req.session.empName,'RESET_PASSWORD',req.params.id,`${t.name}のパスワードをリセット`,ip(req));
  res.json({ok:true});
});

// ── 社員マスタ ─────────────────────────────────────────
app.get('/api/employees',requireAuth,(req,res)=>{
  res.json(D.all(`SELECT e.*,
    CASE WHEN a.password_hash IS NOT NULL THEN 1 ELSE 0 END as has_password,
    a.last_login FROM employees e LEFT JOIN auth a ON e.id=a.emp_id
    ORDER BY CASE e.status WHEN '在籍' THEN 0 WHEN '休職' THEN 1 ELSE 2 END, e.name`));
});

app.post('/api/employees',requireAuth,requireAdmin,(req,res)=>{
  const id='emp'+Date.now();
  const {name,name_kana='',emp_type='社員',status='在籍',role='member',email='',remote_ok=1,client_site=0,join_date='',note=''}=req.body;
  if(!name) return res.status(400).json({error:'氏名は必須です'});
  const n=now();
  D.run(`INSERT INTO employees VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id,name,name_kana,emp_type,status,role,email,remote_ok?1:0,client_site?1:0,join_date,note,n,n]);
  D.run('INSERT INTO auth VALUES (?,NULL,1,NULL)',[id]);
  D.save();
  D.log(req.session.empId,req.session.empName,'ADD_EMPLOYEE',id,`${name}を追加`,ip(req));
  res.json(D.get('SELECT * FROM employees WHERE id=?',[id]));
});

app.put('/api/employees/:id',requireAuth,requireAdmin,(req,res)=>{
  const {name,name_kana='',emp_type='社員',status='在籍',role='member',email='',remote_ok=1,client_site=0,join_date='',note=''}=req.body;
  D.run(`UPDATE employees SET name=?,name_kana=?,emp_type=?,status=?,role=?,email=?,
    remote_ok=?,client_site=?,join_date=?,note=?,updated_at=? WHERE id=?`,
    [name,name_kana,emp_type,status,role,email,remote_ok?1:0,client_site?1:0,join_date,note,now(),req.params.id]);
  D.save();
  D.log(req.session.empId,req.session.empName,'EDIT_EMPLOYEE',req.params.id,`${name}を更新`,ip(req));
  res.json(D.get('SELECT * FROM employees WHERE id=?',[req.params.id]));
});

app.delete('/api/employees/:id',requireAuth,requireAdmin,(req,res)=>{
  const emp=D.get('SELECT name FROM employees WHERE id=?',[req.params.id]);
  if(!emp) return res.status(404).json({error:'社員が見つかりません'});
  D.run('DELETE FROM employees WHERE id=?',[req.params.id]);
  D.run('DELETE FROM auth WHERE emp_id=?',[req.params.id]);
  D.save();
  D.log(req.session.empId,req.session.empName,'DELETE_EMPLOYEE',req.params.id,`${emp.name}を削除`,ip(req));
  res.json({ok:true});
});

// ── 業務タスク ─────────────────────────────────────────
app.get('/api/tasks',requireAuth,(req,res)=>{
  res.json(D.all(`SELECT t.*,a.name as assignee_name,b.name as sub_assignee_name
    FROM tasks t
    LEFT JOIN employees a ON t.assignee_id=a.id
    LEFT JOIN employees b ON t.sub_assignee_id=b.id
    ORDER BY CASE t.priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END, t.title`));
});

app.post('/api/tasks',requireAuth,(req,res)=>{
  const id='task'+Date.now();
  const {category='',title,description='',priority='中',rotation_type='fixed',
    assignee_id=null,sub_assignee_id=null,status='担当未定',frequency='随時',note=''}=req.body;
  if(!title) return res.status(400).json({error:'業務名は必須です'});
  const n=now();
  D.run(`INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id,category,title,description,priority,rotation_type,assignee_id||null,sub_assignee_id||null,status,frequency,note,n,n]);
  D.save();
  D.log(req.session.empId,req.session.empName,'ADD_TASK',id,`「${title}」を追加`,ip(req));
  res.json(D.get('SELECT * FROM tasks WHERE id=?',[id]));
});

app.put('/api/tasks/:id',requireAuth,(req,res)=>{
  const old=D.get('SELECT * FROM tasks WHERE id=?',[req.params.id]);
  if(!old) return res.status(404).json({error:'業務が見つかりません'});
  const {category,title,description,priority,rotation_type,assignee_id,sub_assignee_id,status,frequency,note}=req.body;
  D.run(`UPDATE tasks SET category=?,title=?,description=?,priority=?,rotation_type=?,
    assignee_id=?,sub_assignee_id=?,status=?,frequency=?,note=?,updated_at=? WHERE id=?`,
    [category,title,description,priority,rotation_type,assignee_id||null,sub_assignee_id||null,status,frequency,note,now(),req.params.id]);
  D.save();
  if(old.assignee_id!==(assignee_id||null)){
    const nm=assignee_id?(D.get('SELECT name FROM employees WHERE id=?',[assignee_id])?.name||''):'未設定';
    D.log(req.session.empId,req.session.empName,'ASSIGN_TASK',req.params.id,`「${title}」主担当→${nm}`,ip(req));
  } else {
    D.log(req.session.empId,req.session.empName,'EDIT_TASK',req.params.id,`「${title}」を更新`,ip(req));
  }
  res.json(D.get('SELECT * FROM tasks WHERE id=?',[req.params.id]));
});

app.delete('/api/tasks/:id',requireAuth,requireAdmin,(req,res)=>{
  const t=D.get('SELECT title FROM tasks WHERE id=?',[req.params.id]);
  D.run('DELETE FROM tasks WHERE id=?',[req.params.id]);
  D.save();
  D.log(req.session.empId,req.session.empName,'DELETE_TASK',req.params.id,`「${t?.title}」を削除`,ip(req));
  res.json({ok:true});
});

// ── 出社予定 ───────────────────────────────────────────
app.get('/api/attendance/:ym',requireAuth,(req,res)=>{
  const rows=D.all('SELECT emp_id,day,status FROM attendance WHERE year_month=?',[req.params.ym]);
  const result={};
  rows.forEach(r=>{ if(!result[r.emp_id]) result[r.emp_id]={}; result[r.emp_id][r.day]=r.status; });
  res.json(result);
});

app.put('/api/attendance/:ym/:empId/:day',requireAuth,(req,res)=>{
  const {ym,empId,day}=req.params; const {status}=req.body;
  const existing=D.get('SELECT id FROM attendance WHERE emp_id=? AND year_month=? AND day=?',[empId,ym,parseInt(day)]);
  if(existing){
    D.run('UPDATE attendance SET status=?,updated_by=?,updated_at=? WHERE emp_id=? AND year_month=? AND day=?',
      [status,req.session.empId,now(),empId,ym,parseInt(day)]);
  } else {
    D.run('INSERT INTO attendance VALUES (?,?,?,?,?,?,?)',
      [D.uuidv4(),empId,ym,parseInt(day),status,req.session.empId,now()]);
  }
  D.save();
  const nm=D.get('SELECT name FROM employees WHERE id=?',[empId])?.name||empId;
  D.log(req.session.empId,req.session.empName,'EDIT_ATTENDANCE',empId,`${nm} ${ym}/${day}→${status}`,ip(req));
  res.json({ok:true});
});

// ── 操作ログ ───────────────────────────────────────────
app.get('/api/logs',requireAuth,requireAdmin,(req,res)=>{
  const limit=parseInt(req.query.limit)||100;
  res.json(D.all('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?',[limit]));
});

// ── SPA ────────────────────────────────────────────────
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

// ── 起動 ────────────────────────────────────────────────
init().then(helper=>{
  D=helper;
  app.listen(PORT,()=>{
    console.log(`\n✅ 広島オフィス管理システム v2 起動中`);
    console.log(`   http://localhost:${PORT}\n`);
  });
}).catch(e=>{ console.error('DB初期化エラー:', e); process.exit(1); });
