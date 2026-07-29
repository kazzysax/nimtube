import * as wallet from './nimiq.js';

const CATEGORIES = ['Crypto', 'Football', 'Politics', 'Music', 'Weather', 'AI'];
const STAKES = [1, 3, 5, 10, 20];

const S = {
  token: localStorage.getItem('nimtube.token'),
  me: null,
  step: 0,
  username: '',
  niches: new Set(),
  tab: 'feed',
  category: null,
  feedState: 'open',
  markets: [],
  stake: 3,
  composing: false,
  gateError: null,
};

const el = document.getElementById('app');
const h = (s, ...v) => s.reduce((a, p, i) => a + p + (v[i] ?? ''), '');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { status: r.status });
  return data;
}

// ---------- onboarding ----------------------------------------------------

const dots = n => `<div class="dots">${[0, 1, 2, 3].map(i => `<i class="${i === n ? 'on' : ''}"></i>`).join('')}</div>`;

function screenWelcome() {
  return h`
    <div class="glow"></div><div class="pad">
      ${dots(0)}
      <div class="mid">
        <p class="brand">Nim<span>Tube</span></p>
        <p class="sub">Take a side. Live with it.</p>
        <p class="sub2">Staked · Public · Permanent</p>
      </div>
      <div class="foot">
        <button class="cta" data-go="1">Get started</button>
        <p class="note">${wallet.state.inNimiqPay ? 'Wallet connected' : 'Dev mode'} · <b>20 points</b> waiting</p>
      </div>
    </div>`;
}

function screenUsername() {
  return h`
    <div class="glow"></div><div class="pad">
      ${dots(1)}
      <div class="mid">
        <h2>Claim your name</h2>
        <p class="sub">Every call you make gets filed under it.</p>
        <input id="uname" placeholder="username" autocomplete="off" value="${esc(S.username)}" />
        <p class="hint" id="uhint">Yours permanently. Names are never recycled.</p>
      </div>
      <div class="foot"><button class="cta" id="unext" disabled>Continue</button></div>
    </div>`;
}

function screenNiches() {
  return h`
    <div class="glow"></div><div class="pad">
      ${dots(2)}
      <div class="mid">
        <h2>What do you want to be right about?</h2>
        <p class="sub">Select all that apply</p>
        <div class="grid">
          ${CATEGORIES.map(c => `
            <div class="cell ${S.niches.has(c) ? 'sel' : ''}" data-niche="${c}">
              ${S.niches.has(c) ? '<span class="chk">✓</span>' : ''}
              <b>${c}</b><s>OPEN MARKETS</s>
            </div>`).join('')}
        </div>
      </div>
      <div class="foot">
        <button class="cta" data-go="3" ${S.niches.size ? '' : 'disabled'}>Continue</button>
        <p class="note">${S.niches.size} selected</p>
      </div>
    </div>`;
}

function screenFollow(people) {
  const list = people.length ? people.map(p => `
    <div class="row">
      <span class="av"></span>
      <span class="rm"><b>@${esc(p.username)}</b><s>${p.played} calls settled</s></span>
      <span class="repn">${p.rep}</span>
      <button class="fb" data-follow="${esc(p.username)}">Follow</button>
    </div>`).join('')
    : `<div class="empty">Nobody has a record yet.<br>You could be the first.</div>`;

  return h`
    <div class="glow"></div><div class="pad">
      ${dots(3)}
      <div class="mid">
        <h2>Follow people with a record</h2>
        <p class="sub">to seed your feed</p>
        ${list}
      </div>
      <div class="foot">
        <button class="cta" id="finish">Take a side</button>
        <button class="ghost" id="finish2">Skip for now</button>
      </div>
    </div>`;
}

// ---------- feed ----------------------------------------------------------

function barHtml(m) {
  // Blind until committed: the bar is the one public statistic, and it carries
  // no numbers. Before five wagers there isn't one to show at all.
  if (m.bar === null || m.bar === undefined) {
    return `<div class="bar blind"><u style="width:100%"></u></div>
            <div class="blab"><span>TOO EARLY TO READ</span><span>${m.wagerCount} IN</span></div>`;
  }
  return `<div class="bar"><u class="y" style="width:${m.bar}%"></u><u class="n" style="width:${100 - m.bar}%"></u></div>
          <div class="blab"><span class="yl">YES</span><span class="nl">NO</span></div>`;
}

function postHtml(m) {
  const left = timeLeft(m.closes_at);
  if (m.state === 'resolved' || m.state === 'void') return resolvedHtml(m);

  const committed = m.committed;
  return h`
    <div class="post" data-market="${m.id}">
      <div class="ph"><span class="av"></span><b>@${esc(m.creator?.username || '')}</b>
        <span class="rp">${m.creator?.rep ?? 0}</span><s>${left}</s></div>
      ${m.bounty ? `<span class="bounty">◆ ${m.bounty.nim} NIM × ${m.bounty.winners}</span>` : ''}
      <p class="q">${esc(m.question)}</p>
      <p class="src"><u></u>${esc(m.source_name)}</p>
      ${barHtml(m)}
      ${committed ? `
        <div class="acts">
          <span class="a y" ${m.mySide === 'yes' ? '' : 'disabled'}>Yes</span>
          <span class="a n" ${m.mySide === 'no' ? '' : 'disabled'}>No</span>
        </div>
        <p class="lock">YOU'RE IN ON ${m.mySide.toUpperCase()} · LOCKED</p>`
      : `
        <div class="stakes">${STAKES.map(s =>
          `<span class="st ${S.stake === s ? 'on' : ''}" data-stake="${s}">${s}</span>`).join('')}</div>
        <div class="acts">
          <span class="a y" data-wager="yes">Yes</span>
          <span class="a n" data-wager="no">No</span>
        </div>
        <p class="lock">ONE WAGER · NO EDITS · NO EXITS</p>`}
    </div>`;
}

function resolvedHtml(m) {
  if (m.state === 'void') {
    return h`<div class="post"><span class="stamp">Void</span>
      <div class="ph"><span class="av"></span><b>@${esc(m.creator?.username || '')}</b></div>
      <p class="q">${esc(m.question)}</p>
      <p class="src"><u></u>${esc(m.void_reason || 'Could not be settled')}</p>
      <p class="lock">ALL STAKES REFUNDED · NO REPUTATION MOVED</p></div>`;
  }
  const yes = m.finalBar ?? 50;
  const d = m.myRepDelta;
  return h`
    <div class="post"><span class="stamp">Resolved</span>
      <div class="ph"><span class="av"></span><b>@${esc(m.creator?.username || '')}</b>
        <span class="rp">${m.creator?.rep ?? 0}</span></div>
      <p class="q">${esc(m.question)}</p>
      <div class="bar"><u class="y" style="width:${yes}%"></u><u class="n" style="width:${100 - yes}%"></u></div>
      <div class="blab"><span class="yl">YES${m.outcome === 'YES' ? ' · CORRECT' : ''}</span>
        <span class="nl">NO${m.outcome === 'NO' ? ' · CORRECT' : ''}</span></div>
      ${d !== null && d !== undefined ? `
        <div class="verdict">
          <div><div class="big ${d < 0 ? 'neg' : ''}">${d > 0 ? '+' : ''}${d}</div>
          <div class="lbl">Reputation</div></div>
          <div class="rt">${d >= 4 ? 'Called it against the crowd' : d > 0 ? 'Correct' : 'Missed'}</div>
        </div>` : ''}
      <div class="tiprow">
        <span class="tip" data-tip="${esc(m.creator?.username || '')}" data-mid="${m.id}">◆ Tip 0.5 NIM</span>
        <span class="share" data-share="${m.id}">Share</span>
      </div>
    </div>`;
}

function timeLeft(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'CLOSED';
  const hrs = ms / 36e5;
  return hrs >= 24 ? `${Math.floor(hrs / 24)}D LEFT` : `${Math.max(1, Math.floor(hrs))}H LEFT`;
}

function screenFeed() {
  const chips = ['All', ...CATEGORIES];
  return h`
    <div class="glow"></div>
    <div class="top">
      <span class="logo">Nim<span>Tube</span></span>
      <span class="pts">${S.me?.points ?? 0} PTS</span>
    </div>
    <div class="chips">
      <span class="chip ${S.feedState === 'resolved' ? 'on' : ''}" data-state="resolved">Resolved</span>
      ${chips.map(c => `<span class="chip ${(!S.category && c === 'All') || S.category === c ? 'on' : ''}"
        data-cat="${c === 'All' ? '' : c}">${c}</span>`).join('')}
    </div>
    <div class="feed">
      ${S.markets.length ? S.markets.map(postHtml).join('')
        : `<div class="empty">Nothing here yet.<br>Tap + and make a call.</div>`}
    </div>
    <button class="fab" id="compose">+</button>
    ${tabsHtml()}`;
}

function screenWallet(w) {
  return h`
    <div class="glow"></div>
    <div class="top"><span class="logo">Wallet</span><span class="pts">${w.points} PTS</span></div>
    <div class="feed">
      <div class="post"><p class="src"><u></u>Points</p>
        <p class="q">${w.points} points</p>
        <p class="lock">NO CASH VALUE · CANNOT BE BOUGHT OR SOLD</p></div>
      <div class="post"><p class="src"><u></u>Tips</p>
        <div class="verdict">
          <div><div class="big">${w.tipsReceived}</div><div class="lbl">NIM confirmed</div></div>
          <div class="rt">${w.tipsSent} NIM sent</div>
        </div>
        ${w.tipsPending ? `<p class="lock">${w.tipsPending} NIM AWAITING CONFIRMATION</p>` : ''}
        ${(w.rejected || []).map(x => `<p class="lock" style="color:var(--no)">REJECTED · ${esc(x.failed_reason)}</p>`).join('')}
      </div>
      <div class="post"><p class="src"><u></u>Bounties won</p>
        ${w.bounties.length ? w.bounties.map(b =>
          `<p class="q">${b.amount_nim} NIM${b.paid ? '' : ' · pending'}</p>`).join('')
          : '<div class="empty">None yet.</div>'}</div>
    </div>
    ${tabsHtml()}`;
}

const TABS = [['feed', 'Feed'], ['explore', 'Explore'], ['positions', 'Positions'], ['profile', 'Profile'], ['wallet', 'Wallet']];
const tabsHtml = () => `<div class="tabs">${TABS.map(([k, l]) =>
  `<span class="tab ${S.tab === k ? 'on' : ''}" data-tab="${k}"><i></i>${l}</span>`).join('')}</div>`;

// ---------- compose -------------------------------------------------------

function composeHtml() {
  return h`
    <div class="sheet" id="sheet"><div class="sheetbox">
      <h2 style="text-align:left;font-size:20px">Make a call</h2>
      <p class="sub" style="text-align:left">Write it however you like. It gets rewritten into something that can actually be settled.</p>
      ${S.gateError ? `<div class="err">${esc(S.gateError.reason)}</div>` : ''}
      ${S.gateError?.suggested_fix ? `
        <div class="fix"><b>Try this instead</b><br>${esc(S.gateError.suggested_fix.question)}
        <br><span style="color:var(--dimmer)">Settled by ${esc(S.gateError.suggested_fix.source_name)}</span></div>` : ''}
      <textarea id="ctext" placeholder="will bitcoin pump this month"></textarea>
      <div class="foot"><button class="cta" id="csubmit">Post it</button>
        <button class="ghost" id="ccancel">Cancel</button></div>
    </div></div>`;
}

// ---------- render + events ----------------------------------------------

async function render() {
  if (!S.me) {
    const screens = [screenWelcome, screenUsername, screenNiches];
    if (S.step < 3) el.innerHTML = screens[S.step]();
    else {
      const people = await api('/leaderboard').catch(() => []);
      el.innerHTML = screenFollow(people);
    }
    return bind();
  }
  if (S.tab === 'wallet') {
    const w = await api('/wallet');
    el.innerHTML = screenWallet(w);
  } else {
    const q = new URLSearchParams({ state: S.feedState, ...(S.category ? { category: S.category } : {}) });
    S.markets = await api('/feed?' + q).catch(() => []);
    el.innerHTML = screenFeed();
  }
  if (S.composing) el.insertAdjacentHTML('beforeend', composeHtml());
  bind();
}

function bind() {
  const on = (sel, ev, fn) => el.querySelectorAll(sel).forEach(n => n.addEventListener(ev, fn));

  on('[data-go]', 'click', e => { S.step = Number(e.currentTarget.dataset.go); render(); });

  const uname = el.querySelector('#uname');
  if (uname) {
    const hint = el.querySelector('#uhint'), next = el.querySelector('#unext');
    let t;
    uname.addEventListener('input', () => {
      S.username = uname.value.trim();
      clearTimeout(t);
      next.disabled = true;
      if (!S.username) { hint.className = 'hint'; hint.textContent = 'Yours permanently. Names are never recycled.'; return; }
      t = setTimeout(async () => {
        const r = await api('/username/' + encodeURIComponent(S.username)).catch(() => ({ ok: false, reason: '—' }));
        hint.className = 'hint ' + (r.ok ? 'good' : 'bad');
        hint.textContent = r.ok ? 'Available' : r.reason;
        next.disabled = !r.ok;
      }, 250);
    });
    next.addEventListener('click', () => { S.step = 2; render(); });
    uname.focus();
  }

  on('[data-niche]', 'click', e => {
    const c = e.currentTarget.dataset.niche;
    S.niches.has(c) ? S.niches.delete(c) : S.niches.add(c);
    render();
  });

  on('#finish, #finish2', 'click', async () => {
    const r = await signIn({ username: S.username });
    S.token = r.token; localStorage.setItem('nimtube.token', r.token);
    S.me = r.user; render();
  });

  on('[data-follow]', 'click', async e => {
    const u = e.currentTarget.dataset.follow;
    e.currentTarget.classList.add('on'); e.currentTarget.textContent = 'Following';
    if (S.token) await api(`/users/${u}/follow`, { method: 'POST' }).catch(() => {});
  });

  on('[data-tab]', 'click', e => { S.tab = e.currentTarget.dataset.tab; render(); });
  on('[data-cat]', 'click', e => { S.category = e.currentTarget.dataset.cat || null; S.feedState = 'open'; render(); });
  on('[data-state]', 'click', () => { S.feedState = S.feedState === 'resolved' ? 'open' : 'resolved'; render(); });
  on('[data-stake]', 'click', e => { S.stake = Number(e.currentTarget.dataset.stake); render(); });

  on('[data-wager]', 'click', async e => {
    const side = e.currentTarget.dataset.wager;
    const id = e.currentTarget.closest('[data-market]').dataset.market;
    try {
      await api(`/markets/${id}/wager`, { method: 'POST', body: { side, stake: S.stake } });
      S.me = await api('/me');
      render();
    } catch (err) { alert(err.message); }
  });

  on('#compose', 'click', () => { S.composing = true; S.gateError = null; render(); });
  on('#ccancel', 'click', () => { S.composing = false; render(); });

  on('#csubmit', 'click', async e => {
    const text = el.querySelector('#ctext').value.trim();
    if (!text) return;
    e.currentTarget.disabled = true; e.currentTarget.textContent = 'Checking…';
    try {
      const r = await api('/markets', { method: 'POST', body: { text } });
      if (r.approved) { S.composing = false; S.gateError = null; }
      else S.gateError = r;
      render();
    } catch (err) { S.gateError = { reason: err.message }; render(); }
  });

  on('[data-tip]', 'click', async e => {
    const btn = e.currentTarget;
    const to = btn.dataset.tip, mid = btn.dataset.mid;
    const before = btn.textContent;
    try {
      const profile = await api('/users/' + to);
      if (!profile.address) throw new Error('That account has no wallet address');
      btn.textContent = '◆ Confirm in Nimiq Pay…';

      // The marker is what lets the server match this payment to this market on
      // chain, so it has to go out with the transaction, not after it.
      const hash = await wallet.sendNim(profile.address, 0.5, `nimtube tip m${mid}`);
      await api(`/markets/${mid}/tip`, { method: 'POST', body: { toUsername: to, amountNim: 0.5, txHash: hash } });

      // Not "tipped" — it isn't real until the chain confirms it.
      btn.textContent = '◆ Sent · confirming';
      btn.style.opacity = '.7';
    } catch (err) {
      btn.textContent = before;
      alert(err.message);
    }
  });

  on('[data-share]', 'click', e => {
    const id = e.currentTarget.dataset.share;
    const url = `${location.origin}/?m=${id}`;
    if (navigator.share) navigator.share({ url, title: 'NimTube' }).catch(() => {});
    else { navigator.clipboard?.writeText(url); e.currentTarget.textContent = 'Copied'; }
  });
}

/** Sign in by proving we hold the key for this address: fetch a nonce, sign it
 *  through Nimiq Pay, send the proof. Outside Nimiq Pay there is nothing to sign
 *  with, so the server's dev bypass handles it (never enabled in production). */
async function signIn({ username } = {}) {
  const body = { address: wallet.state.address, deviceHash: wallet.state.deviceHash };
  if (username) body.username = username;

  if (wallet.state.inNimiqPay) {
    const { message } = await api('/challenge', { method: 'POST', body: { address: wallet.state.address } });
    const { publicKey, signature } = await wallet.signMessage(message);
    Object.assign(body, { publicKey, signature, message });
  }
  return api('/session', { method: 'POST', body });
}

// ---------- boot ----------------------------------------------------------

(async function boot() {
  try { await wallet.connect(); } catch (e) { console.warn(e); }

  if (S.token) {
    try {
      S.me = await api('/me');
    } catch { S.token = null; localStorage.removeItem('nimtube.token'); }
  }

  if (!S.me && wallet.state.address) {
    // Returning wallet with an account already: skip straight past onboarding.
    try {
      const r = await signIn();
      if (!r.needsUsername) {
        S.token = r.token; localStorage.setItem('nimtube.token', r.token); S.me = r.user;
      }
    } catch { /* first run, walk the steps */ }
  }
  render();
})();
