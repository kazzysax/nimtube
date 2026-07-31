import * as wallet from './nimiq.js';

const CATEGORIES = ['Crypto', 'Football', 'Politics', 'Music', 'Weather', 'AI'];
const STAKES = [1, 3, 5, 10, 20];

const S = {
  token: localStorage.getItem('predtube.token'),
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
        <p class="brand">Pred<span>Tube</span></p>
        <p class="sub">TRACK CONVICTION WITH SOCIAL REPUTATION</p>
        <p class="sub2">Social · Public · Reputation</p>
      </div>
      <div class="foot">
        <button class="cta" data-go="1">Get started</button>
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
        <p class="hint" id="uhint"></p>
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
    <div class="top" style="justify-content:center">
      <span class="logo">Pred<span>TUBE</span></span>
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
  const bal = (w.balanceNim !== null && w.balanceNim !== undefined) ? w.balanceNim.toFixed(2) : '—';
  return h`
    <div class="glow"></div>
    <div class="top"><span class="logo">Wallet</span><span class="pts">${w.points} PTS</span></div>
    <div class="tiles">
      <div class="tile">
        <span class="tlabel">NIM balance</span>
        <span class="tval">${bal}</span>
      </div>
      <div class="tile action" id="wallettip">
        <span class="tlabel">Tip</span>
        <span class="tval green">◆</span>
        <span class="ttip">Reward a correct call</span>
      </div>
    </div>

    <div class="section"><h3>Assets</h3></div>
    <div class="feed" style="padding-top:0">
      <div class="row"><span class="av"></span>
        <span class="rm"><b>NIM</b><s>On-chain balance</s></span>
        <span class="repn">${bal}</span></div>
      <div class="row"><span class="av"></span>
        <span class="rm"><b>Points</b><s>No cash value · cannot be bought or sold</s></span>
        <span class="repn">${w.points}</span></div>

      <div class="section" style="padding:0"><h3>Tip info</h3></div>
      <div class="post">
        <div class="verdict">
          <div><div class="big">${w.tipsReceived}</div><div class="lbl">NIM confirmed</div></div>
          <div class="rt">${w.tipsSent} NIM sent</div>
        </div>
        ${w.tipsPending ? `<p class="lock">${w.tipsPending} NIM AWAITING CONFIRMATION</p>` : ''}
        ${(w.rejected || []).map(x => `<p class="lock" style="color:var(--no)">REJECTED · ${esc(x.failed_reason)}</p>`).join('')}
      </div>

      <div class="section" style="padding:0"><h3>Bounties won</h3></div>
      <div class="post">
        ${w.bounties.length ? w.bounties.map(b =>
          `<p class="q">${b.amount_nim} NIM${b.paid ? '' : ' · pending'}</p>`).join('')
          : '<div class="empty">None yet.</div>'}</div>
    </div>
    ${tabsHtml()}`;
}

function screenExplore(board) {
  return h`
    <div class="glow"></div>
    <div class="top"><span class="logo">Explore</span><span class="pts">${S.me?.points ?? 0} PTS</span></div>
    <div class="feed">
      <div class="section" style="padding:0 0 2px"><h3>Top predictors</h3></div>
      ${board.length ? board.map((p, i) => `
        <div class="row">
          <span class="rank">${i + 1}</span>
          <span class="av"></span>
          <span class="rm"><b>@${esc(p.username)}</b><s>${p.played} settled · ${p.average} avg</s></span>
          <span class="repn">${p.rep}</span>
          <button class="fb" data-follow="${esc(p.username)}">Follow</button>
        </div>`).join('')
        : `<div class="empty">Nobody has a qualifying record yet.<br>Keep predicting — you could be first.</div>`}
    </div>
    ${tabsHtml()}`;
}

function screenPositions(positions) {
  const rows = positions.map(p => {
    const settled = !!p.settled;
    const won = settled && p.outcome && p.side === p.outcome.toLowerCase();
    return `
      <div class="post">
        <div class="blab" style="margin-bottom:10px">
          <span>${esc(p.category).toUpperCase()}</span>
          <span>${p.state === 'open' ? timeLeft(p.closes_at) : p.state.toUpperCase()}</span>
        </div>
        <p class="q">${esc(p.question)}</p>
        <div class="blab">
          <span class="${p.side === 'yes' ? 'yl' : 'nl'}">${p.side.toUpperCase()} · ${p.stake} PTS</span>
          <span class="${settled ? (won ? 'yl' : 'nl') : ''}">${settled
            ? `${won ? 'WON' : 'LOST'} · ${p.rep_delta > 0 ? '+' : ''}${p.rep_delta ?? 0} REP`
            : 'OPEN'}</span>
        </div>
      </div>`;
  }).join('');
  return h`
    <div class="glow"></div>
    <div class="top"><span class="logo">Positions</span><span class="pts">${S.me?.points ?? 0} PTS</span></div>
    <div class="feed">
      ${positions.length ? rows : `<div class="empty">No wagers yet.<br>Take a side on something in the feed.</div>`}
    </div>
    ${tabsHtml()}`;
}

function screenProfile(p) {
  if (!p) return h`
    <div class="glow"></div>
    <div class="top"><span class="logo">Profile</span></div>
    <div class="feed"><div class="empty">Couldn't load your profile.</div></div>
    ${tabsHtml()}`;

  const posts = p.posts || [];
  return h`
    <div class="glow"></div>
    <div class="top"><span class="logo">Profile</span><span class="pts">${S.me?.points ?? 0} PTS</span></div>
    <div class="profilehead">
      <span class="av"></span>
      <h2>@${esc(p.username)}</h2>
      <p class="sub" style="margin-bottom:0">Joined ${new Date(p.joined).toLocaleDateString()}</p>
    </div>
    <div class="statsrow">
      <div class="stat"><b>${p.rep}</b><s>Reputation</s></div>
      <div class="stat"><b>${p.hitRate === null ? '—' : p.hitRate + '%'}</b><s>Hit rate</s></div>
      <div class="stat"><b>${p.contrarianWins}</b><s>Contrarian</s></div>
    </div>
    <div class="statsrow">
      <div class="stat"><b style="color:var(--yes)">${p.wins}</b><s>Wins</s></div>
      <div class="stat"><b style="color:var(--no)">${p.losses}</b><s>Losses</s></div>
      <div class="stat"><b>${p.played}</b><s>Played</s></div>
    </div>
    <div class="feed" style="padding-top:0">
      <div class="section" style="padding:0 0 2px"><h3>His posts</h3></div>
      ${posts.length ? posts.map(m => `
        <div class="post">
          <p class="q">${esc(m.question)}</p>
          <div class="blab">
            <span>${esc(m.category).toUpperCase()}</span>
            <span>${esc(m.state).toUpperCase()}${m.outcome ? ' · ' + esc(m.outcome) : ''}</span>
          </div>
        </div>`).join('')
        : `<div class="empty">No calls posted yet.</div>`}
    </div>
    ${tabsHtml()}`;
}

const TAB_ICONS = {
  feed: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="18" height="7" rx="1.6"/><rect x="3" y="14" width="18" height="7" rx="1.6"/></svg>`,
  explore: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="9"/><path d="M15.2 8.8l-2.1 6.1-6.1 2.1 2.1-6.1z"/></svg>`,
  positions: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 20V11M12 20V4M20 20v-6"/></svg>`,
  profile: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="8.2" r="3.6"/><path d="M4.5 20c1.4-4.2 4-5.8 7.5-5.8s6.1 1.6 7.5 5.8"/></svg>`,
  wallet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="16.3" cy="14" r="1.1" fill="currentColor" stroke="none"/></svg>`,
};

const TABS = [['feed', 'Feed'], ['explore', 'Explore'], ['positions', 'Positions'], ['profile', 'Profile'], ['wallet', 'Wallet']];
const tabsHtml = () => `<div class="tabs">${TABS.map(([k, l]) =>
  `<span class="tab ${S.tab === k ? 'on' : ''}" data-tab="${k}">${TAB_ICONS[k]}${l}</span>`).join('')}</div>`;

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
  } else if (S.tab === 'explore') {
    const board = await api('/leaderboard').catch(() => []);
    el.innerHTML = screenExplore(board);
  } else if (S.tab === 'positions') {
    const positions = await api('/positions').catch(() => []);
    el.innerHTML = screenPositions(positions);
  } else if (S.tab === 'profile') {
    const profile = await api('/users/' + encodeURIComponent(S.me.username)).catch(() => null);
    el.innerHTML = screenProfile(profile);
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
      if (!S.username) { hint.className = 'hint'; hint.textContent = ''; return; }
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
    try {
      const r = await signIn({ username: S.username });
      S.token = r.token; localStorage.setItem('predtube.token', r.token);
      S.me = r.user; render();
    } catch (err) { alert(err.message); }
  });

  on('[data-follow]', 'click', async e => {
    const u = e.currentTarget.dataset.follow;
    e.currentTarget.classList.add('on'); e.currentTarget.textContent = 'Following';
    if (S.token) await api(`/users/${u}/follow`, { method: 'POST' }).catch(() => {});
  });

  on('[data-tab]', 'click', e => { S.tab = e.currentTarget.dataset.tab; render(); });
  on('#wallettip', 'click', () => { S.tab = 'feed'; S.feedState = 'resolved'; S.category = null; render(); });
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
      const hash = await wallet.sendNim(profile.address, 0.5, `predtube tip m${mid}`);
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
    if (navigator.share) navigator.share({ url, title: 'PredTube' }).catch(() => {});
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
    } catch { S.token = null; localStorage.removeItem('predtube.token'); }
  }

  if (!S.me && wallet.state.address) {
    // Returning wallet with an account already: skip straight past onboarding.
    try {
      const r = await signIn();
      if (!r.needsUsername) {
        S.token = r.token; localStorage.setItem('predtube.token', r.token); S.me = r.user;
      }
    } catch { /* first run, walk the steps */ }
  }
  render();
})();
