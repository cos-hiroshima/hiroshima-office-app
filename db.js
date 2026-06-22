// db.js — sql.js (pure JS SQLite) ラッパー
const initSqlJs = require('sql.js');
const fs   = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const os = require('os');
const DB_PATH = process.env.DB_PATH || path.join(os.tmpdir(), 'office.db');

let db;  // sql.js Database instance

// ── 同期的なヘルパー（better-sqlite3 互換インターフェース） ──
function run(sql, params=[]) {
  db.run(sql, params);
}
function get(sql, params=[]) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    stmt.free();
    const obj = {};
    cols.forEach((c,i) => obj[c] = vals[i]);
    return obj;
  }
  stmt.free();
  return null;
}
function all(sql, params=[]) {
  const result = db.exec(sql, params);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((c,i) => obj[c] = row[i]);
    return obj;
  });
}
function save() {
  const data = db.export();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ── 初期化（非同期） ──────────────────────────────────────
async function init() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const file = fs.readFileSync(DB_PATH);
    db = new SQL.Database(file);
  } else {
    db = new SQL.Database();
  }

  // テーブル定義
  db.run(`PRAGMA foreign_keys = ON`);
  db.run(`CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, name_kana TEXT DEFAULT '',
    emp_type TEXT DEFAULT '社員', status TEXT DEFAULT '在籍',
    role TEXT DEFAULT 'member', email TEXT DEFAULT '',
    remote_ok INTEGER DEFAULT 1, client_site INTEGER DEFAULT 0,
    join_date TEXT DEFAULT '', note TEXT DEFAULT '',
    created_at TEXT DEFAULT '', updated_at TEXT DEFAULT ''
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS auth (
    emp_id TEXT PRIMARY KEY, password_hash TEXT, must_change INTEGER DEFAULT 1,
    last_login TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, category TEXT DEFAULT '', title TEXT NOT NULL,
    description TEXT DEFAULT '', priority TEXT DEFAULT '中',
    rotation_type TEXT DEFAULT 'fixed', assignee_id TEXT, sub_assignee_id TEXT,
    status TEXT DEFAULT '担当未定', frequency TEXT DEFAULT '随時',
    note TEXT DEFAULT '', created_at TEXT DEFAULT '', updated_at TEXT DEFAULT ''
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id TEXT PRIMARY KEY, emp_id TEXT NOT NULL, year_month TEXT NOT NULL,
    day INTEGER NOT NULL, status TEXT NOT NULL, updated_by TEXT, updated_at TEXT DEFAULT ''
  )`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS att_unique ON attendance(emp_id,year_month,day)`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, emp_id TEXT, emp_name TEXT, action TEXT NOT NULL,
    target TEXT, detail TEXT, ip TEXT, created_at TEXT DEFAULT ''
  )`);
  save();

  // 初期データ
  const empCount = get('SELECT COUNT(*) as n FROM employees').n;
  if (empCount === 0) {
    const now = new Date().toISOString().replace('T',' ').slice(0,19);
    const seed = [
      ['emp001','西浦','ニシウラ','取締役','在籍','admin','',1,0,'2015-04-01','7月より広島オフィス責任者兼務'],
      ['emp002','山下','ヤマシタ','社員','在籍','member','',1,0,'2019-04-01',''],
      ['emp003','鈴木','スズキ','社員','在籍','member','',1,0,'2020-04-01',''],
      ['emp004','戸田','トダ','社員','在籍','member','',1,0,'2021-04-01',''],
      ['emp005','宗東','ムネヒガシ','社員','在籍','member','',1,0,'2018-04-01','総務担当・体調不良によりほぼテレワーク'],
      ['emp006','藤原','フジワラ','社員','在籍','member','',1,0,'2022-04-01',''],
      ['emp007','濱口','ハマグチ','社員','在籍','member','',1,0,'2022-10-01',''],
      ['emp008','田中','タナカ','社員','在籍','member','',1,1,'2019-04-01','客先常駐'],
      ['emp009','中野','ナカノ','社員','退職','member','',1,0,'2020-04-01','6月末退職'],
    ];
    for (const r of seed) {
      run(`INSERT INTO employees VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [...r, now, now]);
      run(`INSERT INTO auth VALUES (?,NULL,1,NULL)`, [r[0]]);
    }
    const tasks = [
      ['task001','セキュリティ','ALSOK開閉通知・緊急連絡対応','開閉通知メール受信、緊急時電話対応、休日夜間の施錠依頼','高','fixed',null,null,'担当未定','随時','担当確定後にALSOK側の設定変更が必要'],
      ['task002','入退室管理','Teams入退室記録確認','監査対応のため記録漏れを確認する','中','monthly',null,null,'担当未定','月次','誰かが必ず確認する運用でよい'],
      ['task003','鍵管理','鍵台帳管理（オフィス鍵・ロッカー鍵）','台帳のスプレッドシート化・共有化、鍵の所在一元管理','高','fixed',null,null,'担当未定','随時','現在鍵の所在が複数に分散。統合整理が必要'],
      ['task004','テレワーク管理','出社・テレワーク状況集計','出社人数・テレワーク比率の確認と月次集計','中','monthly',null,null,'担当未定','月次','ルールを1資料に集約する方針'],
      ['task005','備品・消耗品','備品・消耗品発注（アスクル等）','在庫確認・不足時発注、定常品目リストの整備','高','fixed',null,null,'担当未定','随時','発注履歴と調達先の整理が必要'],
      ['task006','清掃','オフィス清掃（週次ローテーション）','週次清掃の実施、担当ローテーション管理','中','weekly',null,null,'担当未定','週次','ペア制検討中。男子トイレ担当偏りも要検討'],
      ['task007','安否確認','災害時安否確認・連絡フロー','大規模災害時の確認・連絡フローの実施','高','fixed','emp001',null,'仮決定','随時','対象範囲の整理が必要'],
      ['task008','業者対応','業者対応（ゴミ・管理会社・工事）','都度対応、連絡先管理、受領、工程表取得','中','fixed',null,null,'担当未定','随時','連絡先一覧・受領責任・リマインド方法の明確化が必要'],
      ['task009','郵便物・個人物品','保険証・郵便物の受領・保管','受領後の本人連絡、金庫保管','低','oncall',null,null,'担当未定','随時（出社者対応）',''],
      ['task010','資産管理','サーバー室・社内資産確認','社内資産管理（プロジェクト検証機とは分けて管理）','中','fixed',null,null,'担当未定','月次',''],
      ['task011','イレギュラー対応','突発・個別対応の報告・判断','突発対応・個別依頼の受付、報告先への連絡','中','fixed','emp001',null,'仮決定','随時','判断基準の明文化が必要'],
    ];
    for (const t of tasks) run(`INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [...t, now, now]);
    save();
    console.log('✅ 初期データを投入しました');
  }

  return { run, get, all, save, uuidv4, log };
}

function now() { return new Date().toISOString().replace('T',' ').slice(0,19); }

function log(empId, empName, action, target, detail, ip) {
  run(`INSERT INTO audit_log VALUES (?,?,?,?,?,?,?,?)`,
    [uuidv4(), empId||'system', empName||'system', action, target||'', detail||'', ip||'', now()]);
  save();
}

module.exports = { init, now };
