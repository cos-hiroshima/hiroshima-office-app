# 広島オフィス管理システム v2 — GitHub + Render デプロイ手順

## 概要
- **GitHub**: コードを管理
- **Render**: サーバーを無料で動かす（Free Plan）
- **アクセスURL**: `https://hiroshima-office-app.onrender.com`（例）

---

## STEP 1: GitHubにリポジトリを作成

1. https://github.com にログイン
2. 右上「＋」→「New repository」
3. 設定：
   - Repository name: `hiroshima-office-app`
   - **Private**（必ず非公開に！）
   - 「Create repository」をクリック

---

## STEP 2: コードをGitHubにアップロード

### PCにGitをインストール（未インストールの場合）
https://git-scm.com/download/win からインストール

### PowerShellで実行
```powershell
# zipを展開した hiroshima-web フォルダへ移動
cd C:\path\to\hiroshima-web

# Git初期化とアップロード
git init
git add .
git commit -m "初回コミット"
git branch -M main
git remote add origin https://github.com/あなたのID/hiroshima-office-app.git
git push -u origin main
```

---

## STEP 3: Renderでサーバーを起動

1. https://render.com にアクセスし「Get Started for Free」
2. **「Sign in with GitHub」** でGitHubアカウントでログイン
3. Dashboard → 「New +」→「Web Service」
4. GitHubリポジトリ一覧から「hiroshima-office-app」を選択→「Connect」
5. 設定：
   - **Name**: `hiroshima-office-app`（任意）
   - **Region**: Singapore（アジア最寄り）
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
6. 「Environment Variables」を追加：
   - `SESSION_SECRET` = 任意のランダム文字列（例：`hiroshima2026xK9mP`）
   - `NODE_ENV` = `production`
7. 「Create Web Service」をクリック

### Diskの追加（データ永続化）
デプロイ後、サービスの「Disks」タブ：
- **Name**: `office-data`
- **Mount Path**: `/data`
- **Size**: 1 GB（無料枠内）
- `DB_PATH` 環境変数を追加: `/data/office.db`

---

## STEP 4: 初回ログイン

デプロイ完了後（5〜10分）、表示されたURLにアクセス。

### 社員IDの体系（初期データ）
| 社員ID | 氏名 |
|--------|------|
| emp001 | 西浦（管理者） |
| emp002 | 山下 |
| emp003 | 鈴木 |
| emp004 | 戸田 |
| emp005 | 宗東 |
| emp006 | 藤原 |
| emp007 | 濱口 |
| emp008 | 田中 |

### 初回ログイン手順（社員全員）
1. URLにアクセス
2. 自分の社員IDを入力
3. 「次へ」→初回パスワード設定画面が表示される
4. 8文字以上のパスワードを設定してログイン

---

## 運用メモ

### 新入社員を追加する場合
1. 管理者（西浦さん）でログイン
2. 「社員マスタ」→「＋ 社員を追加」
3. 追加後に表示される社員IDを本人に通知
4. 本人が初回ログイン時にパスワードを設定

### パスワードを忘れた場合
管理者が「社員マスタ」の「PW↩」ボタンでリセット
→ 社員が次回ログイン時に再設定

### Render Free Planの注意点
- 15分間アクセスがないとサーバーがスリープ
- 次のアクセス時に起動（30秒〜1分かかる）
- 月750時間まで無料（1サービスなら常時利用可）
