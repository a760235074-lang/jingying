// 菁鷹直排輪 課務管理 — 管理員 / 教練 雙身分版本（Firebase）
import { firebaseConfig } from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc,
  onSnapshot, setDoc, updateDoc, deleteDoc, getDoc, writeBatch } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const WD = ['日','一','二','三','四','五','六'];
const LEVELS = ['入門','初級','中級','進階','選手班'];
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const money = n => 'NT$ ' + Math.round(n || 0).toLocaleString('zh-TW');
const endTime = (start, dur) => { const [h, m] = (start || '00:00').split(':').map(Number); const t = h * 60 + m + (+dur || 0); return pad(Math.floor(t / 60) % 24) + ':' + pad(t % 60); };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- 未設定 Firebase ---------- */
if (!firebaseConfig || String(firebaseConfig.apiKey).startsWith('YOUR')) {
  $('#sync').textContent = '尚未設定';
  $('#main').innerHTML = `<div class="view"><div class="empty"><b>還沒有連上資料庫</b>
    <span>請打開 config.js，貼上你在 Firebase 建立的網頁應用程式設定，再重新上傳網站。<br>步驟請看「設定教學.md」。</span></div></div>`;
  throw new Error('Firebase config missing');
}

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
let fs;
try { fs = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (_) { fs = initializeFirestore(fb, {}); }

/* ---------- 狀態 ---------- */
const S = {
  me: null, profile: null, users: [], students: [], classes: [], payments: [], sessions: [],
  settings: { locations: [], absentDeducts: true }, rates: {},
  tab: 'today', day: ymd(new Date()), q: '', month: ymd(new Date()).slice(0, 7), mine: true, unsubs: []
};
const isAdmin = () => S.profile && S.profile.role === 'admin';
const userName = uid => { const u = S.users.find(x => x.id === uid); return u ? (u.name || u.email) : ''; };
const coaches = () => S.users.filter(u => u.role === 'admin' || u.role === 'coach');

/* ---------- 共用 ---------- */
let toastT;
function toast(msg) { let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); } t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2400); }
function fbErr(e) {
  const c = (e && e.code) || '';
  const map = {
    'auth/invalid-email': 'Email 格式不正確。', 'auth/missing-password': '請輸入密碼。',
    'auth/invalid-credential': 'Email 或密碼錯誤。', 'auth/wrong-password': 'Email 或密碼錯誤。', 'auth/user-not-found': '找不到這個帳號，請先註冊。',
    'auth/email-already-in-use': '這個 Email 已經註冊過，請直接登入。', 'auth/weak-password': '密碼至少要 6 個字元。',
    'auth/too-many-requests': '嘗試太多次，請稍後再試。', 'auth/network-request-failed': '網路連線失敗，請檢查網路。',
    'permission-denied': '你沒有權限做這個動作。', 'unavailable': '目前連不上資料庫，網路恢復後會自動同步。'
  };
  return map[c] || ('發生錯誤：' + (e && e.message || c));
}
const setSync = t => $('#sync').textContent = t;

/* ---------- 登入 / 註冊 ---------- */
const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
async function googleLogin() {
  const err = $('#au-err'); err.textContent = '';
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    if (isStandalone()) { await signInWithRedirect(auth, provider); return; }
    const cred = await signInWithPopup(auth, provider);
    await createProfile(cred.user, cred.user.displayName);
  } catch (e) {
    if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) {
      try { await signInWithRedirect(auth, provider); return; } catch (e2) { e = e2; }
    }
    if (e && (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request')) return;
    if (e && e.code === 'auth/unauthorized-domain') { err.textContent = '這個網址還沒加入 Firebase 的授權網域，請管理員到 Authentication → 設定 → 授權網域 新增。'; return; }
    err.textContent = fbErr(e);
  }
}
getRedirectResult(auth).then(r => { if (r && r.user) createProfile(r.user, r.user.displayName).catch(() => {}); }).catch(e => { const el = $('#au-err'); if (el) el.textContent = fbErr(e); });

function authView(mode = 'login', msg = '') {
  $('#nav').hidden = true; closeSheet();
  setSync('未登入');
  const reg = mode === 'register';
  const showEmail = mode !== 'google';
  if (mode === 'google' || mode === 'login' && !msg && !authView.emailOpen) {
    $('#main').innerHTML = `<div class="auth">
      <h2>登入菁鷹</h2>
      <div class="sub">教練第一次登入後，請通知管理員開通。第一位登入的人會自動成為管理員。</div>
      <button class="btn gbtn" id="au-google" type="button"><svg viewBox="0 0 48 48" width="22" height="22" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>使用 Google 帳號登入</button>
      <div class="err" id="au-err">${esc(msg)}</div>
      <button class="linkbtn" id="au-email-open" type="button">改用 Email 登入</button></div>`;
    $('#au-google').onclick = googleLogin;
    $('#au-email-open').onclick = () => { authView.emailOpen = true; authView('login'); };
    return;
  }
  $('#main').innerHTML = `<div class="auth">
    <h2>${reg ? '用 Email 註冊' : '用 Email 登入'}</h2>
    <div class="sub">${reg ? '註冊後請通知管理員開通。第一位註冊的人會自動成為管理員。' : '輸入你的 Email 和密碼。'}</div>
    <form class="form" id="authf">
      ${reg ? `<div class="field"><label for="au-name">姓名（顯示在課表上）</label><input id="au-name" required placeholder="林教練" autocomplete="name"></div>` : ''}
      <div class="field"><label for="au-email">Email</label><input id="au-email" type="email" required autocomplete="email" inputmode="email"></div>
      <div class="field"><label for="au-pw">密碼${reg ? '（至少 6 個字元）' : ''}</label><input id="au-pw" type="password" required minlength="6" autocomplete="${reg ? 'new-password' : 'current-password'}"></div>
      <div class="err" id="au-err">${esc(msg)}</div>
      <button class="btn" type="submit">${reg ? '註冊' : '登入'}</button>
    </form>
    <div class="row wrap"><button class="linkbtn" id="au-sw">${reg ? '已經有帳號？登入' : '還沒有帳號？註冊'}</button>
    ${reg ? '' : '<span class="grow"></span><button class="linkbtn" id="au-forgot">忘記密碼</button>'}</div>
    <button class="btn ghost" id="au-back" type="button">← 回到 Google 登入</button></div>`;
  $('#au-back').onclick = () => { authView.emailOpen = false; authView('google'); };
  $('#au-sw').onclick = () => authView(reg ? 'login' : 'register');
  const fg = $('#au-forgot');
  if (fg) fg.onclick = async () => {
    const em = $('#au-email').value.trim(); if (!em) { $('#au-err').textContent = '請先在上面輸入 Email。'; return; }
    try { await sendPasswordResetEmail(auth, em); $('#au-err').textContent = '已寄出重設密碼信，請到信箱收信。'; } catch (e) { $('#au-err').textContent = fbErr(e); }
  };
  $('#authf').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
    const em = $('#au-email').value.trim(), pw = $('#au-pw').value;
    try {
      if (reg) {
        const name = $('#au-name').value.trim();
        const cred = await createUserWithEmailAndPassword(auth, em, pw);
        await createProfile(cred.user, name);
      } else await signInWithEmailAndPassword(auth, em, pw);
    } catch (err) { $('#au-err').textContent = fbErr(err); btn.disabled = false; }
  };
}
async function createProfile(user, name) {
  const mine = await getDoc(doc(fs, 'users', user.uid)).catch(() => null);
  if (mine && mine.exists()) return; // 已經建立過，不要覆蓋
  const base = { name: name || user.email, email: user.email, createdAt: Date.now() };
  const owner = await getDoc(doc(fs, 'meta', 'owner')).catch(() => null);
  if (owner && !owner.exists()) {
    const b = writeBatch(fs);
    b.set(doc(fs, 'users', user.uid), { ...base, role: 'admin' });
    b.set(doc(fs, 'meta', 'owner'), { uid: user.uid });
    try { await b.commit(); return; } catch (_) { /* 有人搶先成為管理員 */ }
  }
  await setDoc(doc(fs, 'users', user.uid), { ...base, role: 'pending' });
}
function waitView(title, text) {
  $('#nav').hidden = true; setSync(S.me ? S.me.email : '');
  $('#main').innerHTML = `<div class="auth"><div class="empty"><b>${esc(title)}</b><span>${text}</span>
    <button class="btn ghost" id="lo">登出</button></div></div>`;
  $('#lo').onclick = () => signOut(auth);
}

/* ---------- 資料同步 ---------- */
function stopAll() { S.unsubs.forEach(u => { try { u(); } catch (_) {} }); S.unsubs = []; }
let profUnsub = null;
onAuthStateChanged(auth, user => {
  stopAll(); if (profUnsub) { profUnsub(); profUnsub = null; }
  S.me = user; S.profile = null;
  if (!user) return authView();
  setSync('連線中…');
  let started = false, tries = 0;
  profUnsub = onSnapshot(doc(fs, 'users', user.uid), async snap => {
    if (!snap.exists()) {
      // 剛註冊、資料還沒寫好；或資料被刪除
      waitView('正在建立帳號…', '請稍候幾秒。');
      if (tries++ < 1) setTimeout(async () => { try { await createProfile(user, user.displayName || ''); } catch (_) {} }, 4000);
      else setTimeout(() => { if (!S.profile) waitView('找不到帳號資料', '請聯絡管理員，或登出後重新註冊。'); }, 6000);
      return;
    }
    const prev = S.profile && S.profile.role;
    S.profile = { id: snap.id, ...snap.data() };
    const r = S.profile.role;
    if (r === 'pending') { stopAll(); started = false; return waitView('等待管理員開通', `你的帳號（${esc(user.email)}）已註冊。請管理員到「管理 → 教練帳號」按「開通」，開通後這個畫面會自動進入。`); }
    if (r === 'disabled') { stopAll(); started = false; return waitView('帳號已停用', '如有疑問請聯絡管理員。'); }
    if (!started || prev !== r) { stopAll(); started = true; startData(); }
    else render();
  }, err => waitView('無法讀取帳號', esc(fbErr(err))));
});

function sub(ref, fn) {
  S.unsubs.push(onSnapshot(ref, fn, err => { if (err.code !== 'permission-denied') setSync('同步中斷'); }));
}
function startData() {
  $('#nav').hidden = false;
  S.tab = 'today';
  const cols = ['users', 'students', 'classes', 'sessions'];
  if (isAdmin()) cols.push('payments');
  for (const c of cols) sub(collection(fs, c), snap => {
    S[c] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    setSync(snap.metadata.fromCache ? '離線中' : '已同步');
    render();
  });
  sub(doc(fs, 'meta', 'settings'), snap => { if (snap.exists()) S.settings = { locations: [], absentDeducts: true, ...snap.data() }; render(); });
  if (isAdmin()) sub(doc(fs, 'meta', 'rates'), snap => { S.rates = snap.exists() ? snap.data() : {}; render(); });
  renderTabs(); render();
}

/* ---------- 計算 ---------- */
const stuById = id => S.students.find(s => s.id === id);
const clsById = id => S.classes.find(c => c.id === id);
function lessonsOf(sid) {
  const s = stuById(sid); const bought = (s && +s.bought) || 0; let used = 0;
  for (const ss of S.sessions) { const st = ss.status && ss.status[sid]; if (st === 'present' || (st === 'absent' && S.settings.absentDeducts)) used++; }
  return { bought, used, left: bought - used };
}
function leftPill(sid) {
  const { bought, left } = lessonsOf(sid);
  if (!bought) return '<span class="pill info">未繳費</span>';
  const k = left <= 0 ? 'bad' : left <= 2 ? 'warn' : 'ok';
  return `<span class="pill ${k}">剩 <span class="num">${left}</span> 堂</span>`;
}
const lastAttend = sid => { let l = null; for (const ss of S.sessions) if (ss.status && ss.status[sid] === 'present' && (!l || ss.date > l)) l = ss.date; return l; };
const sessionOf = (cid, date) => S.sessions.find(s => s.classId === cid && s.date === date);

/* ---------- 分頁 ---------- */
const ICON = {
  today: '<path d="M4 6h16v14H4z M4 10h16 M9 3v4 M15 3v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  week: '<path d="M4 5h16v15H4z M4 10h16 M10 10v10 M15 10v10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  students: '<circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6 M16 5.5a3 3 0 010 5.6 M18 14.5c2 .8 3 2.8 3 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  pay: '<rect x="3" y="6" width="18" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 10h18 M7 15h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  more: '<path d="M5 20V11 M12 20V5 M19 20v-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'
};
function tabsDef() {
  return isAdmin()
    ? [['today', '今日'], ['week', '課表'], ['students', '學員'], ['pay', '收費'], ['more', '管理']]
    : [['today', '今日'], ['week', '課表'], ['students', '學員'], ['more', '我的']];
}
function renderTabs() {
  $('#tabs').innerHTML = tabsDef().map(([k, l]) => `<button data-tab="${k}" ${S.tab === k ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>${l}</button>`).join('');
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (!b) return; S.tab = b.dataset.tab; renderTabs(); render(); window.scrollTo(0, 0); });

function render() {
  if (!S.profile || !['admin', 'coach'].includes(S.profile.role)) return;
  if (!tabsDef().some(t => t[0] === S.tab)) { S.tab = 'today'; renderTabs(); }
  const v = { today: vToday, week: vWeek, students: vStudents, pay: vPay, more: isAdmin() ? vAdmin : vMine }[S.tab]();
  $('#main').innerHTML = v;
}

const A = isAdmin; // 簡寫
function onboarding() {
  if (!A()) return `<div class="empty"><b>目前還沒有班級或學員</b><span>管理員建立班級並把你設為教練後，你的課就會出現在這裡。</span></div>`;
  const pend = S.users.filter(u => u.role === 'pending').length;
  return `<div class="empty"><b>歡迎，${esc(S.profile.name)}！你是管理員</b>
  <span>從這幾步開始：</span>
  <ol class="steps"><li>請教練用網址自行註冊，再到「管理 → 教練帳號」開通${pend ? `（目前有 ${pend} 位等待中）` : ''}</li><li>到「學員」新增學員與家長聯絡方式</li><li>到「課表」建立班級、指定教練、勾選學員</li><li>到「收費」登記購買堂數，點名就會自動扣堂</li></ol>
  <button class="btn acc" data-act="newStudent">新增第一位學員</button></div>`;
}

function vToday() {
  const d = parseYmd(S.day), wd = d.getDay(), isToday = S.day === ymd(new Date());
  let list = S.classes.filter(c => +c.weekday === wd).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  const myCount = list.filter(c => c.coachUid === S.me.uid).length;
  if (S.mine && !A()) list = list.filter(c => c.coachUid === S.me.uid);
  let h = `<div class="daybar"><button class="round" data-act="dayPrev" aria-label="前一天">‹</button>
    <div class="d"><div class="big">${d.getMonth() + 1}/${d.getDate()}</div><div class="sub">星期${WD[wd]}${isToday ? ' · 今天' : ''}</div></div>
    <button class="round" data-act="dayNext" aria-label="後一天">›</button></div>`;
  if (!isToday) h += `<button class="btn ghost sm" data-act="dayToday" style="align-self:center">回到今天</button>`;
  if (!A()) h += `<div class="seg"><button data-act="mine" data-v="1" aria-pressed="${S.mine}">我的課（${myCount}）</button><button data-act="mine" data-v="0" aria-pressed="${!S.mine}">全部班級</button></div>`;
  if (!S.students.length && !S.classes.length) return `<div class="view">${h}${onboarding()}</div>`;
  if (!list.length) h += `<div class="empty"><b>${S.mine && !A() ? '你' : ''}星期${WD[wd]}沒有課</b>${A() ? `<button class="btn sm" data-act="newClass" data-wd="${wd}">新增星期${WD[wd]}的班級</button>` : ''}</div>`;
  else h += list.map(c => {
    const ss = sessionOf(c.id, S.day); const n = (c.studentIds || []).length;
    const p = ss && ss.status ? Object.values(ss.status).filter(x => x === 'present').length : 0;
    return `<button class="cls ${ss ? 'done' : ''}" data-act="attend" data-id="${c.id}">
      <div class="time">${esc(c.start)}<small>${esc(endTime(c.start, c.duration))}</small></div>
      <div style="min-width:0"><div class="name">${esc(c.name)}</div><div class="meta">${esc([userName(c.coachUid), c.location].filter(Boolean).join(' · '))}</div></div>
      <div>${ss ? `<span class="pill ok">已點名 <span class="num">${p}/${n}</span></span>` : `<span class="pill info"><span class="num">${n}</span> 人 · 點名</span>`}</div></button>`;
  }).join('');
  const low = S.students.filter(s => { const l = lessonsOf(s.id); return l.bought > 0 && l.left <= 2; });
  if (low.length) h += `<div class="sec-h"><h3>堂數快用完</h3><span class="sub">${low.length} 位，記得通知家長續費</span></div>
    <div class="list">${low.sort((a, b) => lessonsOf(a.id).left - lessonsOf(b.id).left).slice(0, 8).map(stuItem).join('')}</div>`;
  return `<div class="view">${h}</div>`;
}
function vWeek() {
  let h = `<div class="row"><h2 class="vt grow">每週課表</h2>${A() ? '<button class="btn acc sm" data-act="newClass">＋ 班級</button>' : ''}</div>`;
  if (!S.classes.length) return `<div class="view">${h}<div class="empty"><b>還沒有班級</b>${A() ? '<span>建立班級後，每週同一時間會自動出現在「今日」。</span><button class="btn" data-act="newClass">建立第一個班級</button>' : '<span>等管理員建立班級。</span>'}</div></div>`;
  for (const wd of [1, 2, 3, 4, 5, 6, 0]) {
    const list = S.classes.filter(c => +c.weekday === wd).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    if (!list.length) continue;
    h += `<div class="wd">星期${WD[wd]}</div><div class="list">` + list.map(c => `<button class="item" data-act="${A() ? 'editClass' : 'viewClass'}" data-id="${c.id}">
      <span class="num" style="font-size:19px;font-weight:700;width:52px">${esc(c.start)}</span>
      <div class="grow"><div class="t">${esc(c.name)} ${c.level ? `<span class="pill info">${esc(c.level)}</span>` : ''}${c.coachUid === S.me.uid ? ' <span class="pill ok">我的</span>' : ''}</div><div class="s">${esc([userName(c.coachUid) || '未指定教練', c.location, (c.studentIds || []).length + ' 位學員'].filter(Boolean).join(' · '))}</div></div><span class="chev">›</span></button>`).join('') + '</div>';
  }
  return `<div class="view">${h}</div>`;
}
function stuItem(s) {
  const cls = S.classes.filter(c => (c.studentIds || []).includes(s.id)).map(c => c.name).join('、');
  return `<button class="item" data-act="student" data-id="${s.id}"><div class="grow"><div class="t">${esc(s.name)} ${s.level ? `<span class="pill info">${esc(s.level)}</span>` : ''}</div>
  <div class="s">${esc(cls || '尚未加入班級')}${s.parent ? ' · ' + esc(s.parent) : ''}</div></div>${leftPill(s.id)}</button>`;
}
function vStudents() {
  let h = `<div class="row"><h2 class="vt grow">學員 <span class="sub num">${S.students.length}</span></h2>${A() ? '<button class="btn acc sm" data-act="newStudent">＋ 學員</button>' : ''}</div>`;
  if (!S.students.length) return `<div class="view">${h}${onboarding()}</div>`;
  h += `<input class="search" id="q" type="search" placeholder="搜尋姓名、家長、電話" value="${esc(S.q)}">`;
  const q = S.q.trim().toLowerCase();
  const list = S.students.filter(s => !q || [s.name, s.parent, s.phone].join(' ').toLowerCase().includes(q))
    .sort((a, b) => lessonsOf(a.id).left - lessonsOf(b.id).left || (a.name || '').localeCompare(b.name || '', 'zh-Hant'));
  h += list.length ? `<div class="list">${list.map(stuItem).join('')}</div>` : `<div class="empty">找不到「${esc(S.q)}」</div>`;
  const idle = S.students.filter(s => { const la = lastAttend(s.id); return la && (Date.now() - parseYmd(la)) / 864e5 > 21; });
  if (idle.length && !q) h += `<div class="sec-h"><h3>超過三週沒來上課</h3></div><div class="list">${idle.map(stuItem).join('')}</div>`;
  return `<div class="view">${h}</div>`;
}
function monthBar() {
  const [y, mm] = S.month.split('-').map(Number);
  return `<div class="daybar"><button class="round" data-act="mPrev" aria-label="上個月">‹</button><div class="d"><div class="big">${y} / ${mm}</div><div class="sub">月份</div></div><button class="round" data-act="mNext" aria-label="下個月">›</button></div>`;
}
function vPay() {
  const list = S.payments.filter(p => (p.date || '').startsWith(S.month)).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const total = list.reduce((a, p) => a + (+p.amount || 0), 0), lessons = list.reduce((a, p) => a + (+p.lessons || 0), 0);
  let h = `<div class="row"><h2 class="vt grow">收費紀錄</h2><button class="btn acc sm" data-act="newPay" ${S.students.length ? '' : 'disabled'}>＋ 收費</button></div>${monthBar()}
  <div class="stats"><div class="stat"><div class="k">本月收入</div><div class="v">${Math.round(total / 100) / 10}<small>千</small></div></div>
  <div class="stat"><div class="k">售出堂數</div><div class="v">${lessons}<small>堂</small></div></div>
  <div class="stat"><div class="k">筆數</div><div class="v">${list.length}<small>筆</small></div></div></div>`;
  if (!S.students.length) h += `<div class="empty"><b>先新增學員</b><span>收費要記在學員名下，堂數才會跟著點名扣。</span><button class="btn" data-act="newStudent">新增學員</button></div>`;
  else if (!list.length) h += `<div class="empty"><b>這個月還沒有收費紀錄</b><span>學員繳費時按「＋ 收費」，登記金額和堂數。</span></div>`;
  else h += `<div class="list">${list.map(p => { const s = stuById(p.studentId); return `<button class="item" data-act="editPay" data-id="${p.id}">
    <div class="grow"><div class="t">${esc(s ? s.name : '（已刪除學員）')}</div><div class="s">${esc(p.date)} · ${esc(p.plan || '課程')} · ${+p.lessons || 0} 堂${p.method ? ' · ' + esc(p.method) : ''}</div></div>
    <span class="money">${money(p.amount)}</span></button>`; }).join('')}</div>`;
  return `<div class="view">${h}</div>`;
}
function monthSessions(uid) { return S.sessions.filter(s => (s.date || '').startsWith(S.month) && (!uid || s.coachUid === uid)); }
function attStats(ses) { let p = 0, l = 0, a = 0; for (const s of ses) for (const v of Object.values(s.status || {})) { if (v === 'present') p++; else if (v === 'leave') l++; else if (v === 'absent') a++; } return { p, l, a, t: p + l + a }; }
function vMine() {
  const ses = monthSessions(S.me.uid); const st = attStats(ses);
  return `<div class="view"><h2 class="vt">${esc(S.profile.name)} <span class="pill info role">教練</span></h2>${monthBar()}
  <div class="stats"><div class="stat"><div class="k">本月上課</div><div class="v">${ses.length}<small>堂</small></div></div>
  <div class="stat"><div class="k">帶過人次</div><div class="v">${st.p}</div></div>
  <div class="stat"><div class="k">出席率</div><div class="v">${st.t ? Math.round(st.p / st.t * 100) : 0}<small>%</small></div></div></div>
  <div class="sec-h"><h3>本月點名紀錄</h3></div>
  ${ses.length ? `<div class="list">${ses.sort((a, b) => b.date.localeCompare(a.date)).map(s => { const c = clsById(s.classId); const x = attStats([s]); return `<div class="item"><div class="grow"><div class="t">${esc(s.date)} · ${esc(c ? c.name : '（已刪除班級）')}</div><div class="s">出席 ${x.p} · 請假 ${x.l} · 缺席 ${x.a}</div></div></div>`; }).join('')}</div>` : '<div class="empty">這個月還沒有點名紀錄。</div>'}
  <div class="card row wrap"><div class="grow sub">${esc(S.me.email)}</div><button class="btn ghost sm" data-act="logout">登出</button></div></div>`;
}
function vAdmin() {
  const ses = monthSessions(); const st = attStats(ses);
  const by = {}; for (const s of ses) { const k = s.coachUid || ''; by[k] = by[k] || { n: 0, p: 0 }; by[k].n++; by[k].p += attStats([s]).p; }
  const pend = S.users.filter(u => u.role === 'pending');
  let h = `<h2 class="vt">管理</h2>`;
  if (pend.length) h += `<div class="banner">有 ${pend.length} 位教練等待開通：${esc(pend.map(u => u.name || u.email).join('、'))}</div>`;
  h += monthBar() + `<div class="stats"><div class="stat"><div class="k">開課堂數</div><div class="v">${ses.length}</div></div>
  <div class="stat"><div class="k">出席率</div><div class="v">${st.t ? Math.round(st.p / st.t * 100) : 0}<small>%</small></div></div>
  <div class="stat"><div class="k">請假 / 缺席</div><div class="v">${st.l}<small>/</small>${st.a}</div></div></div>
  <div class="sec-h"><h3>教練鐘點試算</h3><span class="sub">點名堂數 × 每堂鐘點費</span></div>`;
  const ks = Object.keys(by);
  h += ks.length ? `<div class="list">${ks.map(k => { const r = +S.rates[k] || 0; return `<div class="item"><div class="grow"><div class="t">${esc(userName(k) || '未指定')}</div><div class="s">${by[k].n} 堂 · ${by[k].p} 人次 · 每堂 ${r ? money(r) : '未設定'}</div></div><span class="money">${r ? money(r * by[k].n) : '—'}</span></div>`; }).join('')}</div>` : '<div class="empty">這個月還沒有點名紀錄。</div>';
  h += `<div class="sec-h"><h3>教練帳號</h3><span class="sub">請教練自行用網址註冊</span></div>
  <div class="list">${[...S.users].sort((a, b) => (a.role === 'pending' ? -1 : 0) - (b.role === 'pending' ? -1 : 0)).map(u => {
    const lbl = { admin: ['管理員', 'ok'], coach: ['教練', 'info'], pending: ['等待開通', 'warn'], disabled: ['已停用', 'bad'] }[u.role] || ['?', 'info'];
    return `<button class="item" data-act="member" data-id="${u.id}"><div class="grow"><div class="t">${esc(u.name || u.email)}${u.id === S.me.uid ? '（你）' : ''}</div><div class="s">${esc(u.email)}${S.rates[u.id] ? ' · 每堂 ' + money(S.rates[u.id]) : ''}</div></div><span class="pill ${lbl[1]}">${lbl[0]}</span></button>`;
  }).join('')}</div>
  <div class="sec-h"><h3>設定</h3></div>
  <div class="list"><button class="item" data-act="settings"><div class="grow"><div class="t">上課場地與扣堂規則</div><div class="s">${esc((S.settings.locations || []).join('、') || '尚未設定場地')} · 未請假缺席${S.settings.absentDeducts ? '扣堂' : '不扣堂'}</div></div><span class="chev">›</span></button></div>
  <div class="card row wrap"><div class="grow sub">匯出所有資料成 JSON 檔備份。</div><button class="btn ghost sm" data-act="backup">匯出備份</button></div>
  <div class="card row wrap"><div class="grow sub">${esc(S.me.email)} · 管理員</div><button class="btn ghost sm" data-act="logout">登出</button></div>`;
  return `<div class="view">${h}</div>`;
}

/* ---------- 底部視窗 ---------- */
function openSheet(title, body, onReady) {
  $('#layer').innerHTML = `<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div>
  <div class="sheet-h"><h3>${esc(title)}</h3><button class="btn ghost sm" data-act="close">關閉</button></div>${body}</div></div>`;
  document.body.style.overflow = 'hidden';
  onReady && onReady($('#layer .sheet'));
}
function closeSheet() { $('#layer').innerHTML = ''; document.body.style.overflow = ''; }
$('#layer').addEventListener('click', e => { if (e.target.id === 'scrim') closeSheet(); });
const opts = (arr, sel) => arr.map(v => `<option ${v === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
const dataList = (id, arr) => `<datalist id="${id}">${arr.map(v => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;
const delBlock = (kind, id, label) => `<div><button type="button" class="btn danger" data-act="askDel">刪除${label}</button>
  <div class="confirm" id="delconf" hidden>確定刪除？無法復原。<span class="grow"></span><button type="button" class="btn ghost sm" data-act="cancelDel">取消</button><button type="button" class="btn sm" style="background:var(--bad)" data-act="doDel" data-kind="${kind}" data-id="${id}">刪除</button></div></div>`;

async function save(col, id, data) {
  try { await setDoc(doc(fs, col, id || newId()), data); return true; }
  catch (e) { toast(fbErr(e)); return false; }
}
async function del(col, id) {
  try {
    if (col === 'students') {
      const b = writeBatch(fs);
      for (const c of S.classes.filter(c => (c.studentIds || []).includes(id))) b.update(doc(fs, 'classes', c.id), { studentIds: c.studentIds.filter(x => x !== id) });
      b.delete(doc(fs, 'students', id)); await b.commit();
    } else if (col === 'payments') {
      const p = S.payments.find(x => x.id === id);
      await deleteDoc(doc(fs, 'payments', id));
      if (p) await syncBought(p.studentId, id, 0);
    } else await deleteDoc(doc(fs, col, id));
    return true;
  } catch (e) { toast(fbErr(e)); return false; }
}
// 學員的「已購堂數」存在學員資料上，教練看不到收費金額也能算剩餘堂數
async function syncBought(sid, changedId, changedLessons) {
  if (!sid || !stuById(sid)) return;
  let sum = changedLessons || 0;
  for (const p of S.payments) if (p.studentId === sid && p.id !== changedId) sum += (+p.lessons || 0);
  await updateDoc(doc(fs, 'students', sid), { bought: sum });
}

function studentForm(s) {
  s = s || {};
  openSheet(s.id ? '編輯學員' : '新增學員', `<form class="form" id="f">
    <div class="field"><label for="f-name">學員姓名</label><input id="f-name" name="name" required value="${esc(s.name)}" placeholder="王小鷹"></div>
    <div class="two"><div class="field"><label for="f-level">程度</label><select id="f-level" name="level"><option value="">—</option>${opts(LEVELS, s.level)}</select></div>
    <div class="field"><label for="f-birth">出生年</label><input id="f-birth" name="birth" inputmode="numeric" value="${esc(s.birth)}" placeholder="2017"></div></div>
    <div class="two"><div class="field"><label for="f-parent">家長</label><input id="f-parent" name="parent" value="${esc(s.parent)}" placeholder="王媽媽"></div>
    <div class="field"><label for="f-phone">電話 / LINE</label><input id="f-phone" name="phone" value="${esc(s.phone)}" placeholder="0912-345-678"></div></div>
    <div class="two"><div class="field"><label for="f-shoe">鞋號</label><input id="f-shoe" name="shoe" value="${esc(s.shoe)}" placeholder="32"></div>
    <div class="field"><label for="f-joined">入學日</label><input id="f-joined" name="joined" type="date" value="${esc(s.joined || ymd(new Date()))}"></div></div>
    <div class="field"><label for="f-note">備註</label><textarea id="f-note" name="note" placeholder="過敏、護具、學習狀況…">${esc(s.note)}</textarea></div>
    <button class="btn" type="submit">${s.id ? '儲存' : '新增學員'}</button>
    ${s.id ? delBlock('students', s.id, '學員') : ''}</form>`, sh => {
    $('#f', sh).onsubmit = async e => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target)); fd.name = fd.name.trim(); if (!fd.name) return;
      const id = s.id || newId();
      if (await save('students', id, { ...fd, bought: +s.bought || 0, createdAt: s.createdAt || Date.now() })) { toast(s.id ? '已儲存' : '已新增 ' + fd.name); s.id ? openStudent(id) : closeSheet(); }
    };
  });
}
function openStudent(id) {
  const s = stuById(id); if (!s) return closeSheet();
  const L = lessonsOf(id);
  const pays = A() ? S.payments.filter(p => p.studentId === id).sort((a, b) => (b.date || '').localeCompare(a.date || '')) : [];
  const hist = S.sessions.filter(ss => ss.status && ss.status[id]).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
  const cls = S.classes.filter(c => (c.studentIds || []).includes(id));
  const lbl = { present: ['出席', 'ok'], leave: ['請假', 'warn'], absent: ['缺席', 'bad'] };
  const col = L.bought && L.left <= 0 ? 'bad' : L.bought && L.left <= 2 ? 'warn' : 'fg';
  openSheet(s.name, `
    <div class="card row"><div class="grow"><div class="sub">剩餘堂數</div><div class="big-left"><span class="v" style="color:var(--${col})">${L.left}</span><span class="sub">堂（買 ${L.bought}、用 ${L.used}）</span></div></div>
    ${A() ? `<button class="btn acc" data-act="newPay" data-sid="${id}">收費</button>` : ''}</div>
    <div class="card"><dl class="kv">
      <dt>程度</dt><dd>${esc(s.level || '—')}</dd><dt>班級</dt><dd>${esc(cls.map(c => c.name + '（週' + WD[c.weekday] + ' ' + c.start + '）').join('、') || '尚未加入')}</dd>
      <dt>家長</dt><dd>${esc(s.parent || '—')}</dd><dt>聯絡</dt><dd>${s.phone ? `<a href="tel:${esc(s.phone.replace(/[^\d+]/g, ''))}">${esc(s.phone)}</a>` : '—'}</dd>
      ${s.birth ? `<dt>出生年</dt><dd>${esc(s.birth)}</dd>` : ''}${s.shoe ? `<dt>鞋號</dt><dd>${esc(s.shoe)}</dd>` : ''}
      ${s.joined ? `<dt>入學</dt><dd>${esc(s.joined)}</dd>` : ''}${s.note ? `<dt>備註</dt><dd>${esc(s.note)}</dd>` : ''}
    </dl></div>
    ${A() ? `<div class="sec-h"><h3>收費紀錄</h3></div>${pays.length ? `<div class="list">${pays.map(p => `<button class="item" data-act="editPay" data-id="${p.id}"><div class="grow"><div class="t">${esc(p.plan || '課程')} · ${+p.lessons || 0} 堂</div><div class="s">${esc(p.date)}${p.method ? ' · ' + esc(p.method) : ''}</div></div><span class="money">${money(p.amount)}</span></button>`).join('')}</div>` : '<div class="empty">還沒有收費紀錄</div>'}` : ''}
    <div class="sec-h"><h3>最近上課</h3></div>
    ${hist.length ? `<div class="list">${hist.map(ss => { const c = clsById(ss.classId); const [t, k] = lbl[ss.status[id]] || ['?', 'info']; return `<div class="item"><div class="grow"><div class="t">${esc(ss.date)}</div><div class="s">${esc(c ? c.name : '（已刪除班級）')}${ss.note ? ' · ' + esc(ss.note) : ''}</div></div><span class="pill ${k}">${t}</span></div>`; }).join('')}</div>` : '<div class="empty">還沒有點名紀錄</div>'}
    ${A() ? `<button class="btn ghost" data-act="editStudent" data-id="${id}">編輯學員資料</button>` : ''}`);
}
function coachOptions(sel) { return '<option value="">未指定</option>' + coaches().map(u => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.name || u.email)}</option>`).join(''); }
function classForm(c, wd) {
  c = c || { weekday: wd != null ? wd : new Date().getDay(), start: '18:00', duration: 60 };
  const sel = new Set(c.studentIds || []);
  const studs = [...S.students].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-Hant'));
  openSheet(c.id ? '編輯班級' : '新增班級', `<form class="form" id="f">
    <div class="field"><label for="c-name">班級名稱</label><input id="c-name" name="name" required value="${esc(c.name)}" placeholder="週六初級班"></div>
    <div class="two"><div class="field"><label for="c-wd">星期</label><select id="c-wd" name="weekday">${[1, 2, 3, 4, 5, 6, 0].map(i => `<option value="${i}" ${+c.weekday === i ? 'selected' : ''}>星期${WD[i]}</option>`).join('')}</select></div>
    <div class="field"><label for="c-level">程度</label><select id="c-level" name="level"><option value="">—</option>${opts(LEVELS, c.level)}</select></div></div>
    <div class="two"><div class="field"><label for="c-start">開始時間</label><input id="c-start" name="start" type="time" required value="${esc(c.start)}"></div>
    <div class="field"><label for="c-dur">每堂分鐘</label><input id="c-dur" name="duration" type="number" inputmode="numeric" min="15" step="15" value="${esc(c.duration)}"></div></div>
    <div class="two"><div class="field"><label for="c-coach">教練</label><select id="c-coach" name="coachUid">${coachOptions(c.coachUid)}</select></div>
    <div class="field"><label for="c-loc">場地</label><input id="c-loc" name="location" list="dl-loc" value="${esc(c.location)}" placeholder="板橋第一運動場">${dataList('dl-loc', S.settings.locations || [])}</div></div>
    <div class="field"><label>上課學員（已選 ${sel.size} 位）</label>
    ${studs.length ? `<div class="chk">${studs.map(s => `<label><input type="checkbox" name="sid" value="${s.id}" ${sel.has(s.id) ? 'checked' : ''}>${esc(s.name)}</label>`).join('')}</div>` : '<div class="sub">先到「學員」新增學員，再回來勾選。</div>'}</div>
    <button class="btn" type="submit">${c.id ? '儲存' : '建立班級'}</button>
    ${c.id ? delBlock('classes', c.id, '班級') : ''}</form>`, sh => {
    $('#f', sh).onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const d = { name: fd.get('name').trim(), weekday: +fd.get('weekday'), level: fd.get('level'), start: fd.get('start'), duration: +fd.get('duration') || 60,
        coachUid: fd.get('coachUid'), location: fd.get('location').trim(), studentIds: fd.getAll('sid'), createdAt: c.createdAt || Date.now() };
      if (!d.name) return;
      if (await save('classes', c.id, d)) {
        const locs = S.settings.locations || [];
        if (d.location && !locs.includes(d.location)) await setDoc(doc(fs, 'meta', 'settings'), { ...S.settings, locations: [...locs, d.location] }).catch(() => {});
        toast(c.id ? '已儲存' : '已建立 ' + d.name); closeSheet();
      }
    };
  });
}
function viewClass(cid) {
  const c = clsById(cid); if (!c) return;
  const studs = (c.studentIds || []).map(stuById).filter(Boolean);
  openSheet(c.name, `<div class="card"><dl class="kv"><dt>時間</dt><dd>星期${WD[c.weekday]} ${esc(c.start)}–${esc(endTime(c.start, c.duration))}</dd>
    <dt>教練</dt><dd>${esc(userName(c.coachUid) || '未指定')}</dd><dt>場地</dt><dd>${esc(c.location || '—')}</dd><dt>程度</dt><dd>${esc(c.level || '—')}</dd></dl></div>
    <div class="sec-h"><h3>學員 ${studs.length} 位</h3></div>
    ${studs.length ? `<div class="list">${studs.map(stuItem).join('')}</div>` : '<div class="empty">還沒有學員</div>'}`);
}
function payForm(p, sid) {
  p = p || { studentId: sid || '', date: ymd(new Date()), lessons: 8, plan: '8 堂課程', method: '現金' };
  const studs = [...S.students].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-Hant'));
  openSheet(p.id ? '編輯收費' : '登記收費', `<form class="form" id="f">
    <div class="field"><label for="p-stu">學員</label><select id="p-stu" name="studentId" required><option value="">選擇學員</option>${studs.map(s => `<option value="${s.id}" ${p.studentId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="p-plan">方案</label><input id="p-plan" name="plan" list="dl-plan" value="${esc(p.plan)}">${dataList('dl-plan', ['4 堂課程', '8 堂課程', '12 堂課程', '單堂', '暑期營隊', '檢定報名'])}</div>
    <div class="two"><div class="field"><label for="p-les">堂數</label><input id="p-les" name="lessons" type="number" inputmode="numeric" min="0" value="${esc(p.lessons)}"></div>
    <div class="field"><label for="p-amt">金額（NT$）</label><input id="p-amt" name="amount" type="number" inputmode="numeric" min="0" required value="${esc(p.amount)}" placeholder="3200"></div></div>
    <div class="two"><div class="field"><label for="p-date">收款日</label><input id="p-date" name="date" type="date" required value="${esc(p.date)}"></div>
    <div class="field"><label for="p-meth">付款方式</label><select id="p-meth" name="method">${opts(['現金', '轉帳', 'LINE Pay', '街口', '其他'], p.method)}</select></div></div>
    <div class="field"><label for="p-note">備註</label><input id="p-note" name="note" value="${esc(p.note)}" placeholder="兄弟姊妹優惠、含護具…"></div>
    <button class="btn" type="submit">${p.id ? '儲存' : '登記收費'}</button>
    ${p.id ? delBlock('payments', p.id, '這筆收費') : ''}</form>`, sh => {
    $('#f', sh).onsubmit = async e => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target)); if (!fd.studentId) return;
      fd.lessons = +fd.lessons || 0; fd.amount = +fd.amount || 0; fd.createdAt = p.createdAt || Date.now(); fd.by = S.me.uid;
      const id = p.id || newId();
      if (await save('payments', id, fd)) {
        try { await syncBought(fd.studentId, id, fd.lessons); if (p.studentId && p.studentId !== fd.studentId) await syncBought(p.studentId, id, 0); } catch (err) { toast(fbErr(err)); }
        toast('已登記 ' + money(fd.amount)); sid ? openStudent(fd.studentId) : closeSheet();
      }
    };
  });
}
function attendSheet(cid) {
  const c = clsById(cid); if (!c) return;
  const ss = sessionOf(cid, S.day);
  const status = { ...(ss && ss.status || {}) };
  const studs = (c.studentIds || []).map(stuById).filter(Boolean);
  if (!ss) studs.forEach(s => status[s.id] = 'present');
  const draw = () => studs.map(s => { const v = status[s.id]; const L = lessonsOf(s.id); return `<div class="att"><div class="grow"><div class="nm">${esc(s.name)}</div><div class="sub">剩 ${L.left} 堂</div></div>
    <div class="tri" data-sid="${s.id}"><button type="button" class="p" aria-pressed="${v === 'present'}" data-v="present">出席</button><button type="button" class="l" aria-pressed="${v === 'leave'}" data-v="leave">請假</button><button type="button" class="a" aria-pressed="${v === 'absent'}" data-v="absent">缺席</button></div></div>`; }).join('');
  openSheet(`${c.name} · ${S.day.slice(5).replace('-', '/')}`, `
    <div class="sub">${esc([c.start + '–' + endTime(c.start, c.duration), userName(c.coachUid), c.location].filter(Boolean).join(' · '))}</div>
    ${studs.length ? `<div class="list" id="attl">${draw()}</div>
    <div class="field"><label for="a-coach">本堂教練</label><select id="a-coach">${coachOptions((ss && ss.coachUid) || c.coachUid || S.me.uid)}</select></div>
    <div class="field"><label for="a-note">課堂紀錄</label><textarea id="a-note" placeholder="今天練了交叉步、T 字煞車…">${esc(ss && ss.note)}</textarea></div>
    <button class="btn" id="a-save">${ss ? '更新點名' : '完成點名'}</button>
    ${ss ? '<button class="btn ghost" id="a-clear">取消這堂點名（退回堂數）</button>' : ''}`
    : `<div class="empty"><b>這個班還沒有學員</b>${A() ? `<button class="btn sm" data-act="editClass" data-id="${cid}">編輯班級、勾選學員</button>` : '<span>請管理員把學員加進這個班。</span>'}</div>`}`, sh => {
    const l = $('#attl', sh); if (!l) return;
    l.addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; status[b.parentElement.dataset.sid] = b.dataset.v; l.innerHTML = draw(); });
    $('#a-save', sh).onclick = async () => {
      const d = { classId: cid, date: S.day, status, coachUid: $('#a-coach', sh).value, note: $('#a-note', sh).value, updatedBy: S.me.uid, updatedAt: Date.now() };
      if (await save('sessions', cid + '_' + S.day, d)) { toast('點名完成'); closeSheet(); }
    };
    const cl = $('#a-clear', sh); if (cl) cl.onclick = async () => { if (await del('sessions', cid + '_' + S.day)) { toast('已取消點名'); closeSheet(); } };
  });
}
function memberSheet(uid) {
  const u = S.users.find(x => x.id === uid); if (!u) return;
  const self = uid === S.me.uid;
  openSheet(u.name || u.email, `<form class="form" id="f">
    <div class="sub">${esc(u.email)}</div>
    <div class="field"><label for="m-name">顯示名稱</label><input id="m-name" value="${esc(u.name)}"></div>
    <div class="field"><label for="m-role">身分</label><select id="m-role" ${self ? 'disabled' : ''}>
      ${[['coach', '教練'], ['admin', '管理員'], ['pending', '等待開通'], ['disabled', '停用']].map(([v, t]) => `<option value="${v}" ${u.role === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
      ${self ? '<span class="sub">不能變更自己的身分，避免沒有管理員。</span>' : ''}</div>
    <div class="field"><label for="m-rate">每堂鐘點費（NT$，只有管理員看得到）</label><input id="m-rate" type="number" inputmode="numeric" min="0" value="${esc(S.rates[uid] || '')}" placeholder="800"></div>
    ${u.role === 'pending' ? '<button class="btn acc" type="button" id="m-approve">開通為教練</button>' : ''}
    <button class="btn" type="submit">儲存</button></form>`, sh => {
    const doSave = async role => {
      try {
        await updateDoc(doc(fs, 'users', uid), { name: $('#m-name', sh).value.trim() || u.email, role: self ? u.role : role });
        await setDoc(doc(fs, 'meta', 'rates'), { ...S.rates, [uid]: +$('#m-rate', sh).value || 0 });
        toast('已儲存'); closeSheet();
      } catch (e) { toast(fbErr(e)); }
    };
    const ap = $('#m-approve', sh); if (ap) ap.onclick = () => doSave('coach');
    $('#f', sh).onsubmit = e => { e.preventDefault(); doSave($('#m-role', sh).value); };
  });
}
function settingsSheet() {
  const st = S.settings;
  openSheet('場地與扣堂規則', `<form class="form" id="f">
    <div class="field"><label for="s-loc">上課場地（一行一個）</label><textarea id="s-loc" placeholder="板橋第一運動場&#10;新莊體育館">${esc((st.locations || []).join('\n'))}</textarea></div>
    <div class="field"><label for="s-abs">未請假缺席</label><select id="s-abs"><option value="1" ${st.absentDeducts ? 'selected' : ''}>扣堂</option><option value="0" ${st.absentDeducts ? '' : 'selected'}>不扣堂</option></select></div>
    <button class="btn" type="submit">儲存設定</button></form>`, sh => {
    $('#f', sh).onsubmit = async e => {
      e.preventDefault();
      const locations = $('#s-loc', sh).value.split(/[\n,，、]/).map(x => x.trim()).filter(Boolean);
      try { await setDoc(doc(fs, 'meta', 'settings'), { locations, absentDeducts: $('#s-abs', sh).value === '1' }); toast('設定已儲存'); closeSheet(); } catch (err) { toast(fbErr(err)); }
    };
  });
}
function backup() {
  const data = JSON.stringify({ app: '菁鷹直排輪', exportedAt: new Date().toISOString(), settings: S.settings, rates: S.rates, users: S.users, students: S.students, classes: S.classes, payments: S.payments, sessions: S.sessions }, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = '菁鷹備份-' + ymd(new Date()) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('備份已下載');
}

/* ---------- 按鈕事件 ---------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const a = b.dataset.act, id = b.dataset.id;
  switch (a) {
    case 'close': closeSheet(); break;
    case 'dayPrev': S.day = ymd(addDays(parseYmd(S.day), -1)); render(); break;
    case 'dayNext': S.day = ymd(addDays(parseYmd(S.day), 1)); render(); break;
    case 'dayToday': S.day = ymd(new Date()); render(); break;
    case 'mine': S.mine = b.dataset.v === '1'; render(); break;
    case 'mPrev': case 'mNext': { const [y, m] = S.month.split('-').map(Number); const d = new Date(y, m - 1 + (a === 'mNext' ? 1 : -1), 1); S.month = d.getFullYear() + '-' + pad(d.getMonth() + 1); render(); break; }
    case 'newStudent': if (A()) studentForm(); break;
    case 'editStudent': if (A()) studentForm(stuById(id)); break;
    case 'student': openStudent(id); break;
    case 'newClass': if (A()) classForm(null, b.dataset.wd != null ? +b.dataset.wd : null); break;
    case 'editClass': if (A()) classForm(clsById(id)); break;
    case 'viewClass': viewClass(id); break;
    case 'attend': attendSheet(id); break;
    case 'newPay': payForm(null, b.dataset.sid); break;
    case 'editPay': payForm(S.payments.find(p => p.id === id)); break;
    case 'member': memberSheet(id); break;
    case 'settings': settingsSheet(); break;
    case 'backup': backup(); break;
    case 'logout': closeSheet(); await signOut(auth); break;
    case 'askDel': $('#delconf').hidden = false; b.hidden = true; break;
    case 'cancelDel': $('#delconf').hidden = true; $('[data-act="askDel"]').hidden = false; break;
    case 'doDel': if (await del(b.dataset.kind, id)) { toast('已刪除'); closeSheet(); } break;
  }
});
document.addEventListener('input', e => {
  if (e.target.id !== 'q') return;
  S.q = e.target.value; const pos = e.target.selectionStart; render();
  const q = $('#q'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (_) {} }
});
