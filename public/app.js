import * as wallet from './nimiq.js';

const CATEGORIES = ['Crypto', 'Sports', 'Music', 'Politics', 'Other'];
const STAKES = [1, 3, 5, 10, 20];
const PRIOR_WAGERS = 3;              // below this the bar is still mostly its 50/50 prior

const S = {
  token: localStorage.getItem('predtube.token'),
  me: null,
  step: 0,
  username: '',
  avatar: Math.floor(Math.random() * 15),
  niches: new Set(),
  pendingFollows: new Set(),
  tab: 'feed',
  section: 'Following',
  feedState: 'open',
  markets: [],
  stake: 3,
  composing: false,
  gateError: null,
  viewUser: null,
  tipTarget: null,
  poolOpen: false,
  pool: { nim: '', winners: '' },
  draft: '',
  draft2: null,
  owed: [],
  voters: null,
  digest: null,
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

const dots = n => `<div class="dots">${[0, 1, 2, 3, 4].map(i => `<i class="${i === n ? 'on' : ''}"></i>`).join('')}</div>`;

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

function screenAvatar() {
  return h`
    <div class="glow"></div><div class="pad">
      ${dots(2)}
      <div class="mid">
        <h2>Pick a face</h2>
        <p class="sub">One is already picked for you. Change it if you like.</p>
        <div class="avgrid">
          ${Array.from({ length: AVATAR_COUNT }, (_, i) => `
            <span class="avpick ${S.avatar === i ? 'sel' : ''}" data-avatar="${i}">
              <img src="/avatars/${String(i).padStart(2, '0')}.jpg" alt="" decoding="async">
            </span>`).join('')}
        </div>
      </div>
      <div class="foot"><button class="cta" data-go="3">Continue</button></div>
    </div>`;
}

function screenNiches() {
  return h`
    <div class="glow"></div><div class="pad">
      ${dots(3)}
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
        <button class="cta" data-go="4" ${S.niches.size ? '' : 'disabled'}>Continue</button>
        <p class="note">${S.niches.size} selected</p>
      </div>
    </div>`;
}

function screenFollow(people) {
  const list = people.length ? people.map(p => `
    <div class="row">
      ${avatar(p.username, p.avatar)}
      <span class="rm"><b>@${esc(p.username)}</b><s>${p.posts} call${p.posts === 1 ? '' : 's'} · ${p.followers} follower${p.followers === 1 ? '' : 's'}</s></span>
      <span class="repn">${p.rep}</span>
      <button class="fb" data-follow="${esc(p.username)}">Follow</button>
    </div>`).join('')
    : `<div class="empty">Nobody else is here yet.<br>You could be the first.</div>`;

  return h`
    <div class="glow"></div><div class="pad">
      ${dots(4)}
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

// ---------- avatars -------------------------------------------------------

const AVATAR_COUNT = 15;

/** Everyone has a picture. It comes from the account, but a username-derived
 *  fallback keeps older rows and mid-signup previews from rendering an empty
 *  hole while the real one is still being chosen. */
const avHash = s => {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return Math.abs(h);
};

const avatarIndex = (n, username) =>
  Number.isInteger(n) && n >= 0 && n < AVATAR_COUNT ? n : avHash(String(username || '?').toLowerCase()) % AVATAR_COUNT;

function avatar(username, index, extra = '') {
  const i = avatarIndex(index, username);
  return `<span class="av ${extra}">
    <img src="/avatars/${String(i).padStart(2, '0')}.jpg" alt="" loading="lazy" decoding="async"></span>`;
}

// ---------- feed ----------------------------------------------------------

function barHtml(m) {
  // The bar is the one public statistic and it carries no numbers. Every market
  // opens at 50/50; early calls barely move it, so a thin book reads as thin
  // rather than as a landslide.
  const settling = m.wagerCount < PRIOR_WAGERS;
  return `<div class="bar"><u class="y" style="width:${m.bar}%"></u><u class="n" style="width:${100 - m.bar}%"></u></div>
          <div class="blab">
            <span class="yl">YES</span>
            ${settling ? `<span class="warm">${m.wagerCount || 'NO'} CALL${m.wagerCount === 1 ? '' : 'S'} IN · STILL SETTLING</span>` : ''}
            <span class="nl">NO</span>
          </div>`;
}

function postHtml(m) {
  const left = timeLeft(m.closes_at);
  if (m.state === 'resolved' || m.state === 'void') return resolvedHtml(m);

  const committed = m.committed;
  return h`
    <div class="post" data-market="${m.id}">
      <div class="ph">${avatar(m.creator?.username, m.creator?.avatar)}<b data-viewuser="${esc(m.creator?.username || '')}">@${esc(m.creator?.username || '')}</b>
        <span class="rp">${m.creator?.rep ?? 0}</span>
        <s class="${left.soon ? 'soon' : ''}">${left.text}</s></div>
      ${tipPoolPill(m)}
      <p class="q">${esc(m.said || m.question)}</p>
      <p class="src"><u></u>${esc(m.source_name)}</p>
      ${barHtml(m)}
      ${committed ? `
        <div class="inbadge ${m.mySide === 'yes' ? 'y' : 'n'}">
          <i>◆</i> You're in on ${m.mySide.toUpperCase()} <i>· locked</i>
        </div>`
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

/** The author's promise: this much NIM each, to the top scorers on this call. */
const tipPoolPill = m => m.tipPool
  ? `<span class="bounty">◆ ${m.tipPool.nim} NIM × ${m.tipPool.winners} top scorer${m.tipPool.winners === 1 ? '' : 's'}</span>`
  : '';

function resolvedHtml(m) {
  if (m.state === 'void') {
    return h`<div class="post"><span class="stamp">Void</span>
      <div class="ph">${avatar(m.creator?.username, m.creator?.avatar)}<b>@${esc(m.creator?.username || '')}</b></div>
      <p class="q">${esc(m.said || m.question)}</p>
      <p class="src"><u></u>${esc(m.void_reason || 'Could not be settled')}</p>
      <p class="lock">ALL STAKES REFUNDED · NO REPUTATION MOVED</p></div>`;
  }
  const yes = m.finalBar ?? 50;
  const d = m.myRepDelta;
  return h`
    <div class="post" data-market="${m.id}"><span class="stamp">Resolved</span>
      <div class="ph">${avatar(m.creator?.username, m.creator?.avatar)}<b data-viewuser="${esc(m.creator?.username || '')}">@${esc(m.creator?.username || '')}</b>
        <span class="rp">${m.creator?.rep ?? 0}</span></div>
      <p class="q">${esc(m.said || m.question)}</p>
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
        <span class="share" data-share="${m.id}">Share</span>
      </div>
    </div>`;
}

/** Under an hour it counts down in minutes and turns red — that window is when
 *  the decision actually costs you something. */
function timeLeft(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return { text: 'CLOSED', soon: true };
  const hrs = ms / 36e5;
  if (hrs >= 24) return { text: `${Math.floor(hrs / 24)}D LEFT`, soon: false };
  if (hrs >= 1) return { text: `${Math.floor(hrs)}H LEFT`, soon: hrs < 2 };
  return { text: `${Math.max(1, Math.round(ms / 6e4))}M LEFT`, soon: true };
}

/** What happened while you were gone. Sits above the feed rather than in a
 *  notification screen nobody opens: results you have not seen, and the daily
 *  points waiting to be claimed. */
function digestHtml(d) {
  if (!d) return '';
  const { results = [], daily } = d;
  if (!results.length && !daily?.available) return '';

  const card = r => {
    const cls = r.voided ? 'v' : r.won ? 'w' : 'l';
    const verdict = r.voided ? 'VOID' : r.won ? 'WON' : 'LOST';
    const delta = r.voided ? 'Stake refunded'
      : `${r.rep_delta > 0 ? '+' : ''}${r.rep_delta ?? 0} rep · ${r.won ? `${r.stake} pts back` : `${r.stake} pts gone`}`;
    return `
      <div class="dg ${cls}" data-market="${r.market_id}">
        <div class="dgtop"><span class="dgv">${verdict}</span>
          <span class="dgs">You were on ${esc(String(r.side).toUpperCase())}</span></div>
        <p class="dgq">${esc(r.said)}</p>
        <p class="dgd">${r.voided ? esc(r.void_reason || 'Could not be settled') : delta}</p>
      </div>`;
  };

  return `
    <div class="digest">
      ${daily?.available ? `
        <div class="dg claim" id="dailyclaim">
          <div class="dgtop"><span class="dgv">DAILY</span></div>
          <p class="dgq">Your ${daily.amount} points are waiting</p>
          <button class="dgbtn">Claim ${daily.amount} points</button>
        </div>` : ''}
      ${results.length ? `
        <div class="dghead">
          <h3>While you were away</h3>
          <span class="dgclear" id="digestseen">Clear</span>
        </div>
        ${results.map(card).join('')}` : ''}
    </div>`;
}

function screenFeed() {
  const chips = ['Following', 'All', ...CATEGORIES];
  return h`
    <div class="glow"></div>
    <div class="top" style="justify-content:center">
      <span class="logo">Pred<span>TUBE</span></span>
    </div>
    <div class="chips">
      <span class="chip ${S.feedState === 'resolved' ? 'on' : ''}" data-state="resolved">Resolved</span>
      ${chips.map(c => `<span class="chip ${S.section === c ? 'on' : ''}"
        data-section="${c}">${c}</span>`).join('')}
    </div>
    <div class="feed">
      ${digestHtml(S.digest)}
      ${S.markets.length ? S.markets.map(postHtml).join('')
        : `<div class="empty">Nothing here yet.<br>Tap + and make a call.</div>`}
    </div>
    <button class="fab" id="compose">+</button>
    ${tabsHtml()}`;
}

const I_STACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
  <ellipse cx="12" cy="6" rx="7.4" ry="3"/><path d="M4.6 6v6c0 1.66 3.31 3 7.4 3s7.4-1.34 7.4-3V6"/>
  <path d="M4.6 12v6c0 1.66 3.31 3 7.4 3s7.4-1.34 7.4-3v-6"/></svg>`;
const I_INFO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
  <circle cx="12" cy="12" r="9.2"/><path d="M12 11.2v5.4" stroke-linecap="round"/>
  <circle cx="12" cy="7.7" r="1.15" fill="currentColor" stroke="none"/></svg>`;
const I_HEX = `<svg viewBox="0 0 24 24"><polygon points="6.2,2.6 17.8,2.6 23,12 17.8,21.4 6.2,21.4 1,12" fill="currentColor"/></svg>`;
const I_PLANE = `<svg viewBox="0 0 24 24" fill="currentColor">
  <path d="M2.3 11.4 21.3 3.1c.6-.26 1.22.36.96.96l-8.3 19c-.27.62-1.15.6-1.38-.05l-2.6-7.25a1 1 0 0 0-.6-.6L2.35 12.8c-.66-.24-.68-1.12-.05-1.4Z"/></svg>`;

function screenWallet(w, owed = []) {
  const bal = (w.balanceNim !== null && w.balanceNim !== undefined) ? w.balanceNim.toFixed(2) : '—';
  const total = owed.reduce((n, a) => n + a.amount_nim, 0);
  return h`
    <div class="glow"></div>
    <div class="whead"><h1>Wallet</h1></div>

    <div class="wtiles">
      <div class="wtile nim">
        <div class="wtop">
          <span class="wbadge blue">${I_STACK}</span>
          <span class="wlabel">NIM balance</span>
          <span class="winfo" title="Live on-chain balance for your Nimiq address">${I_INFO}</span>
        </div>
        <div class="wbal">${bal}</div>
        <div class="wunit">NIM</div>
        <div class="stage"><span class="plinth"></span><span class="coin"></span></div>
      </div>

      <div class="wtile tip" id="wallettip">
        <div class="wtop">
          <span class="wbadge green">${I_HEX}</span>
          <span class="wlabel">Tip</span>
        </div>
        <div class="stage lit"><span class="coin"></span></div>
        <div class="wcap"><b>Reward a correct call</b><s>Send NIM to any username.</s></div>
      </div>
    </div>

    <div class="wsec"><h3>Assets</h3></div>
    <div class="group">
      <div class="grow">
        <span class="gicon">${I_HEX}</span>
        <span class="gm"><b>NIM</b><s>On-chain balance</s></span>
        <span class="gv"><b>${bal}</b><s>NIM</s></span>
      </div>
    </div>

    <div class="wsec"><h3>Tip info</h3></div>
    <div class="group tipinfo">
      <span class="lead"><b>${w.tipsReceived}</b><s>NIM confirmed</s></span>
      <span class="plane">${I_PLANE}</span>
      <span class="sent"><b>${w.tipsSent} NIM</b><s>sent</s></span>
    </div>
    ${w.pool?.wins ? `
      <div class="group poolwin">
        <span class="gm"><b>Top-scorer tips</b><s>${w.pool.wins} call${w.pool.wins === 1 ? '' : 's'} you placed top on</s></span>
        <span class="gv"><b>${w.pool.owed}</b><s>NIM owed you</s></span>
      </div>` : ''}

    ${owed.length ? `
      <div class="wsec"><h3>You owe</h3></div>
      <div class="group">
        ${owed.map(a => `
          <div class="grow">
            <span class="gm"><b>@${esc(a.username)}</b><s>${esc(a.question)}</s></span>
            <span class="gv"><b>${a.amount_nim}</b><s>NIM</s></span>
            <button class="fb pay" data-pay="${a.id}" ${a.submitted ? 'disabled' : ''}>
              ${a.submitted ? 'Confirming' : 'Pay'}</button>
          </div>
          ${a.failed_reason ? `<p class="lock" style="color:var(--no);margin:0 0 10px">${esc(a.failed_reason).toUpperCase()}</p>` : ''}
        `).join('')}
      </div>
      <p class="poolnote" style="padding:9px 18px 0">
        ${total.toFixed(2)} NIM promised to the top scorers on your calls.
        Each one is a separate transaction you approve in Nimiq Pay.</p>` : ''}
    ${w.tipsPending ? `<p class="lock">${w.tipsPending} NIM AWAITING CONFIRMATION</p>` : ''}
    ${(w.rejected || []).map(x => `<p class="lock" style="color:var(--no)">REJECTED · ${esc(x.failed_reason)}</p>`).join('')}

    <div class="wfill"></div>
    ${tabsHtml()}`;
}

/** A one-time onboarding nudge, not a permanent fixture — gone once every quest
 *  is done. Rewards are already banked server-side by the time this renders;
 *  this is only ever a read of what happened, never what causes it. */
function questsHtml(quests) {
  if (!quests?.length || quests.every(q => q.done)) return '';
  return `
    <div class="section" style="padding:0 0 2px"><h3>Welcome checklist</h3></div>
    <div class="qlist">
      ${quests.map(q => `
        <div class="qrow ${q.done ? 'done' : ''}">
          <span class="qcheck">${q.done ? '✓' : ''}</span>
          <span class="qm"><b>${esc(q.label)}</b><s>${q.progress}/${q.target}</s></span>
          <span class="qreward">+${q.reward}</span>
        </div>`).join('')}
    </div>`;
}

function screenExplore(board, quests) {
  return h`
    <div class="glow"></div>
    <div class="top"><span class="logo">Explore</span><span class="pts">${S.me?.points ?? 0} PTS</span></div>
    <div class="feed">
      ${questsHtml(quests)}
      <div class="section" style="padding:0 0 2px"><h3>People to follow</h3></div>
      ${board.length ? board.map(p => `
        <div class="row" data-viewuser="${esc(p.username)}">
          ${avatar(p.username, p.avatar)}
          <span class="rm"><b>@${esc(p.username)}</b>
            <s>${p.posts} call${p.posts === 1 ? '' : 's'} · ${p.followers} follower${p.followers === 1 ? '' : 's'}</s></span>
          <span class="repn">${p.rep}</span>
          <button class="fb" data-toggle-follow="${esc(p.username)}">Follow</button>
        </div>`).join('')
        : `<div class="empty">You're following everyone here.<br>Your feed is as full as it gets.</div>`}
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
          <span>${p.state === 'open' ? timeLeft(p.closes_at).text : p.state.toUpperCase()}</span>
        </div>
        <p class="q">${esc(p.said || p.question)}</p>
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

const TIP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 3v13M12 3l-4 4M12 3l4 4"/><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>`;

function screenProfile(p, isSelf = true) {
  if (!p) return h`
    <div class="glow"></div>
    <div class="top"><span class="logo">Profile</span></div>
    <div class="feed"><div class="empty">Couldn't load that profile.</div></div>
    ${tabsHtml()}`;

  const posts = p.posts || [];
  return h`
    <div class="glow"></div>
    <div class="top">
      ${isSelf ? '' : `<span class="backbtn" data-back>‹</span>`}
      <span class="logo">${isSelf ? 'Profile' : '@' + esc(p.username)}</span>
      ${isSelf
        ? `<span class="pts">${S.me?.points ?? 0} PTS</span>`
        : `<span class="tipicon" data-tip-profile="${esc(p.username)}" title="Tip @${esc(p.username)}">${TIP_ICON}</span>`}
    </div>
    <div class="profilehead">
      ${avatar(p.username, p.avatar)}
      <h2>@${esc(p.username)}</h2>
      <p class="sub" style="margin-bottom:10px">Joined ${new Date(p.joined).toLocaleDateString()}</p>
      <div class="socialrow">
        <span class="soc"><b>${p.followers}</b><s>Followers</s></span>
        <span class="soc"><b>${p.following}</b><s>Following</s></span>
      </div>
      ${p.isMe ? '' : `
        <button class="followbtn ${p.isFollowing ? 'on' : ''}" data-toggle-follow="${esc(p.username)}">
          ${p.isFollowing ? 'Following' : 'Follow'}</button>`}
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
      <div class="section" style="padding:0 0 2px"><h3>${isSelf ? 'Your' : 'Their'} posts</h3></div>
      ${posts.length ? posts.map(m => `
        <div class="post">
          <p class="q">${esc(m.said || m.question)}</p>
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

const I_COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>`;

function composeHtml() {
  // Second step: the gate has read it and is stating the terms. Their words are
  // what gets posted; this is only what it will be judged against.
  if (S.draft2) {
    return h`
      <div class="sheet" id="sheet"><div class="sheetbox scroll">
        <h2 style="text-align:left;font-size:20px">This is how it settles</h2>
        <p class="sub" style="text-align:left;margin-bottom:14px">
          Your post keeps your words. These are the terms it gets judged against.</p>
        <p class="saidq">${esc(S.draft2.said)}</p>
        ${termsHtml(S.draft2.terms)}
        <div class="foot">
          <button class="cta" id="dconfirm">Post it</button>
          <button class="ghost" id="dback">Back, let me reword it</button>
        </div>
      </div></div>`;
  }

  return h`
    <div class="sheet" id="sheet"><div class="sheetbox">
      <h2 style="text-align:left;font-size:20px">Make a call</h2>
      <p class="sub" style="text-align:left">Say it however you like — your words are what gets posted. We'll show you how it settles before it goes up.</p>
      ${S.gateError ? `<div class="err">${esc(S.gateError.reason)}</div>` : ''}
      ${S.gateError?.suggested_fix ? `
        <div class="fix">
          <div class="fixhead">
            <b>Try this instead</b>
            <span class="copy" id="fixcopy" title="Copy this wording">${I_COPY}<i>Copy</i></span>
          </div>
          <p class="fixq">${esc(S.gateError.suggested_fix.question)}</p>
          <span style="color:var(--dimmer)">Settled by ${esc(S.gateError.suggested_fix.source_name)}</span>
          <button class="fixuse" id="fixuse">Use this wording</button>
        </div>` : ''}
      <textarea id="ctext" placeholder="good morning, what do you reckon BTC does in the next hour?"></textarea>

      <div class="pool ${S.poolOpen ? 'on' : ''}">
        <div class="poolhead" id="pooltoggle">
          <span class="poolmark">◆</span>
          <span class="poolt"><b>Tip the top scorers</b><s>Optional. Paid when this call settles.</s></span>
          <span class="poolchev">${S.poolOpen ? '−' : '+'}</span>
        </div>
        ${S.poolOpen ? `
          <div class="poolbody">
            <label>
              <s>NIM each</s>
              <input id="pnim" type="number" min="0" step="0.01" placeholder="0.10" value="${S.pool.nim}" />
            </label>
            <label>
              <s>People</s>
              <input id="pwin" type="number" min="0" max="20" step="1" placeholder="5" value="${S.pool.winners}" />
            </label>
          </div>
          <p class="poolnote">Goes to the highest scorers on this call — the sharpest reads, not the biggest stakes.</p>`
        : ''}
      </div>

      <div class="foot"><button class="cta" id="csubmit">Post it</button>
        <button class="ghost" id="ccancel">Cancel</button></div>
    </div></div>`;
}

// ---------- terms of resolution --------------------------------------------
// The post keeps the author's own words. This is the contract underneath them:
// the exact wording, the source, and what counts as YES or NO. Shown before you
// post, and to anyone who opens the post afterwards.

const when = iso => {
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

function termsHtml(t) {
  return `
    <div class="terms">
      <div class="tline"><s>Settles as</s><b>${esc(t.question)}</b></div>
      <div class="tline"><s>Source</s><b>${esc(t.source_name)}</b>
        ${t.source_detail ? `<em>${esc(t.source_detail)}</em>` : ''}</div>
      <div class="tsplit">
        <div class="tline y"><s>Counts as YES</s><b>${esc(t.criteria_yes)}</b></div>
        <div class="tline n"><s>Counts as NO</s><b>${esc(t.criteria_no)}</b></div>
      </div>
      <div class="tsplit">
        <div class="tline"><s>Betting closes</s><b>${when(t.closes_at)}</b></div>
        <div class="tline"><s>Settles</s><b>${when(t.resolves_at)}</b></div>
      </div>
    </div>`;
}

// ---------- who's in -------------------------------------------------------

/** The book, once you're part of it. Conviction is drawn relative to the
 *  loudest wager, so the shape reads without publishing anyone's balance. */
/** Opening a post: their words at the top, the terms it settles against below,
 *  and the book underneath — that last part only once you have a position. */
function votersSheetHtml() {
  const v = S.voters;
  const m = v.market;

  const yes = v.list.filter(p => p.side === 'yes');
  const no = v.list.filter(p => p.side === 'no');
  const col = (label, cls, people) => `
    <div class="vcol">
      <h4 class="${cls}">${label} · ${people.length}</h4>
      ${people.length ? people.map(p => `
        <div class="vrow ${p.isMe ? 'me' : ''}">
          <span class="vname" data-viewuser="${esc(p.username)}">@${esc(p.username)}</span>
          ${p.isMe ? '<i class="vme">you</i>' : ''}
          <span class="vbar"><u class="${cls}" style="width:${p.conviction}%"></u></span>
          <span class="vstake">${p.stake}</span>
        </div>`).join('')
        : '<p class="vempty">Nobody yet.</p>'}
    </div>`;

  return h`
    <div class="sheet" id="sheet"><div class="sheetbox scroll">
      <p class="saidq">${esc(m?.said || m?.question || '')}</p>
      <p class="saidby">@${esc(m?.creator?.username || '')} · ${esc(m?.category || '')}</p>

      <div class="tsec"><h4>How this settles</h4></div>
      ${m ? termsHtml(m) : '<p class="vempty">Terms unavailable.</p>'}

      <div class="tsec"><h4>Who's in</h4></div>
      ${v.locked
        ? `<p class="vempty" style="padding:2px 0 4px">
             Who's in, and how hard, is for people with points on the line.
             Take YES or NO and the book opens.</p>`
        : `<p class="sub" style="text-align:left;margin-bottom:12px">
             ${v.list.length} call${v.list.length === 1 ? '' : 's'} · bar length is conviction, number is points staked.</p>
           <div class="vcols">${col('YES', 'y', yes)}${col('NO', 'n', no)}</div>`}

      <div class="foot"><button class="ghost" id="vclose">Close</button></div>
    </div></div>`;
}

// ---------- tipping --------------------------------------------------------

function tipSheetHtml() {
  const t = S.tipTarget;
  return h`
    <div class="sheet" id="sheet"><div class="sheetbox">
      <h2 style="text-align:left;font-size:20px">Send NIM</h2>
      <p class="sub" style="text-align:left">Goes out through Nimiq Pay. Confirms on chain before it counts.</p>
      ${t.error ? `<div class="err">${esc(t.error)}</div>` : ''}
      ${t.locked
        ? `<p class="hint good" style="margin-bottom:12px">To @${esc(t.username)}</p>`
        : `<input id="tipuser" placeholder="username" autocomplete="off" value="${esc(t.username)}" />`}
      <input id="tipamount" type="number" min="0" step="0.01" placeholder="Amount in NIM"
        value="${t.amount || ''}" style="margin-top:${t.locked ? '0' : '10px'}" />
      <div class="foot">
        <button class="cta" id="tipsend" ${t.sending ? 'disabled' : ''}>${t.sending ? 'Confirm in Nimiq Pay…' : 'Send'}</button>
        <button class="ghost" id="tipcancel">Cancel</button>
      </div>
    </div></div>`;
}

// ---------- render + events ----------------------------------------------

async function render() {
  if (!S.me) {
    const screens = [screenWelcome, screenUsername, screenAvatar, screenNiches];
    if (S.step < 4) el.innerHTML = screens[S.step]();
    else {
      const people = await api('/explore').catch(() => []);
      el.innerHTML = screenFollow(people);
    }
    return bind();
  }
  if (S.tab === 'wallet') {
    const [w, owed] = await Promise.all([api('/wallet'), api('/payouts').catch(() => [])]);
    S.owed = owed;
    el.innerHTML = screenWallet(w, owed);
  } else if (S.tab === 'explore') {
    const [board, quests] = await Promise.all([
      api('/explore').catch(() => []),
      api('/quests').catch(() => []),
    ]);
    el.innerHTML = screenExplore(board, quests);
  } else if (S.tab === 'positions') {
    const positions = await api('/positions').catch(() => []);
    el.innerHTML = screenPositions(positions);
  } else if (S.tab === 'profile') {
    const uname = S.viewUser || S.me.username;
    const profile = await api('/users/' + encodeURIComponent(uname)).catch(() => null);
    el.innerHTML = screenProfile(profile, uname === S.me.username);
  } else {
    // Following/All are scope, not category — everything else narrows within
    // the whole app, the same way tapping into a category on any social feed
    // means "show me this topic from everyone," not just people I follow.
    const scope = S.section === 'Following' ? 'following' : 'all';
    const category = (S.section !== 'Following' && S.section !== 'All') ? S.section : null;
    const q = new URLSearchParams({ state: S.feedState, scope, ...(category ? { category } : {}) });
    const [markets, digest] = await Promise.all([
      api('/feed?' + q).catch(() => []),
      api('/digest').catch(() => null),
    ]);
    S.markets = markets; S.digest = digest;
    el.innerHTML = screenFeed();
  }
  if (S.composing) el.insertAdjacentHTML('beforeend', composeHtml());
  if (S.tipTarget) el.insertAdjacentHTML('beforeend', tipSheetHtml());
  if (S.voters) el.insertAdjacentHTML('beforeend', votersSheetHtml());
  bind();
}

function bind() {
  const on = (sel, ev, fn) => el.querySelectorAll(sel).forEach(n => n.addEventListener(ev, fn));
  const readPool = () => {
    S.pool = {
      nim: el.querySelector('#pnim')?.value ?? S.pool.nim,
      winners: el.querySelector('#pwin')?.value ?? S.pool.winners,
    };
  };

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
      const r = await signIn({ username: S.username, avatar: S.avatar });
      S.token = r.token; localStorage.setItem('predtube.token', r.token);
      S.me = r.user;
      // Follows chosen during onboarding could not be sent until the account existed.
      for (const u of S.pendingFollows) {
        await api(`/users/${encodeURIComponent(u)}/follow`, { method: 'POST' }).catch(() => {});
      }
      S.pendingFollows.clear();
      render();
    } catch (err) { alert(err.message); }
  });

  on('[data-avatar]', 'click', e => { S.avatar = Number(e.currentTarget.dataset.avatar); render(); });

  // Onboarding runs before there is a session, so these are remembered and
  // replayed once the account exists.
  on('[data-follow]', 'click', async e => {
    e.stopPropagation();
    const btn = e.currentTarget;
    const u = btn.dataset.follow;
    const on = btn.classList.toggle('on');
    btn.textContent = on ? 'Following' : 'Follow';
    on ? S.pendingFollows.add(u) : S.pendingFollows.delete(u);
  });

  on('[data-toggle-follow]', 'click', async e => {
    e.stopPropagation();
    const btn = e.currentTarget;
    const u = btn.dataset.toggleFollow;
    const following = btn.classList.contains('on');
    btn.disabled = true;
    try {
      await api(`/users/${encodeURIComponent(u)}/follow`, { method: following ? 'DELETE' : 'POST' });
      // Following a 2nd person can complete a quest and pay out points, so the
      // header balance needs a refresh alongside the feed rebuild.
      S.me = await api('/me').catch(() => S.me);
      render();
    } catch (err) { btn.disabled = false; alert(err.message); }
  });

  on('[data-viewuser]', 'click', e => {
    const u = e.currentTarget.dataset.viewuser;
    if (!u) return;
    S.tab = 'profile'; S.viewUser = u; render();
  });
  on('[data-back]', 'click', () => { S.viewUser = null; render(); });

  // Opening a post shows its book. Clicks that landed on something interactive
  // inside the card belong to that control, not to the card.
  on('.post[data-market]', 'click', async e => {
    if (e.target.closest('[data-stake],[data-wager],[data-viewuser],[data-share],[data-pay],button')) return;
    const id = Number(e.currentTarget.dataset.market);
    // The terms are public — they are the contract everyone is wagering against.
    // Only the book behind them is gated.
    const market = S.markets.find(x => x.id === id) || await api(`/markets/${id}`).catch(() => null);
    try {
      const list = await api(`/markets/${id}/voters`);
      S.voters = { marketId: id, market, list, locked: false };
    } catch (err) {
      // 403 is the rule working, not a failure: you have not taken a side yet.
      if (err.status !== 403) return alert(err.message);
      S.voters = { marketId: id, market, list: [], locked: true };
    }
    render();
  });
  on('#vclose', 'click', () => { S.voters = null; render(); });

  on('#dailyclaim', 'click', async e => {
    const btn = e.currentTarget.querySelector('.dgbtn');
    btn.disabled = true; btn.textContent = 'Claiming…';
    try {
      const r = await api('/daily', { method: 'POST' });
      S.me = { ...S.me, points: r.points };
      render();
    } catch (err) { btn.disabled = false; alert(err.message); }
  });

  on('#digestseen', 'click', async e => {
    e.stopPropagation();
    // Clear it locally first so the strip goes immediately rather than after a
    // round trip; the results are already banked in rep and points either way.
    S.digest = { ...S.digest, results: [] };
    render();
    await api('/digest/seen', { method: 'POST' }).catch(() => {});
  });

  on('[data-tab]', 'click', e => { S.viewUser = null; S.tab = e.currentTarget.dataset.tab; render(); });
  on('#wallettip', 'click', () => { S.tipTarget = { username: '', locked: false, amount: '', sending: false, error: null }; render(); });
  on('[data-tip-profile]', 'click', e => {
    S.tipTarget = { username: e.currentTarget.dataset.tipProfile, locked: true, amount: '', sending: false, error: null };
    render();
  });
  on('[data-section]', 'click', e => { S.section = e.currentTarget.dataset.section; S.feedState = 'open'; render(); });
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

  on('#compose', 'click', () => {
    S.composing = true; S.gateError = null;
    S.poolOpen = false; S.pool = { nim: '', winners: '' };
    S.draft = ''; S.draft2 = null;
    render();
  });
  on('#ccancel', 'click', () => { S.composing = false; render(); });

  // The sheet is re-rendered on every gate rejection, so what's typed has to
  // survive in state rather than in the DOM.
  const ctext = el.querySelector('#ctext');
  if (ctext) {
    if (S.draft) ctext.value = S.draft;
    ctext.addEventListener('input', () => { S.draft = ctext.value; });
  }
  // The gate's rewrite is usually what you wanted — make it one tap to take it.
  on('#fixuse', 'click', () => {
    const q = S.gateError?.suggested_fix?.question;
    if (!q) return;
    S.draft = q;
    const box = el.querySelector('#ctext');
    if (box) { box.value = q; box.focus(); }
  });

  on('#fixcopy', 'click', async e => {
    const q = S.gateError?.suggested_fix?.question;
    if (!q) return;
    const label = e.currentTarget.querySelector('i');
    try {
      await navigator.clipboard.writeText(q);
      label.textContent = 'Copied';
    } catch {
      // Clipboard access can be refused; selecting the text still lets them copy.
      const box = el.querySelector('.fixq');
      if (box) getSelection().selectAllChildren(box);
      label.textContent = 'Select + copy';
    }
    setTimeout(() => { label.textContent = 'Copy'; }, 1600);
  });

  on('#pooltoggle', 'click', () => { S.poolOpen = !S.poolOpen; readPool(); render(); });
  on('#pnim, #pwin', 'input', readPool);

  on('#csubmit', 'click', async e => {
    const text = (el.querySelector('#ctext')?.value || '').trim();
    if (!text) return;
    readPool();
    S.draft = text;

    const tipNim = Number(S.pool.nim) || 0;
    const tipWinners = Number(S.pool.winners) || 0;
    if (tipNim > 0 && tipWinners < 1) {
      S.gateError = { reason: 'Say how many people the tip is split between.' }; return render();
    }
    if (tipWinners > 0 && tipNim <= 0) {
      S.gateError = { reason: 'Say how much NIM each winner gets.' }; return render();
    }

    e.currentTarget.disabled = true; e.currentTarget.textContent = 'Reading it…';
    try {
      // Nothing exists yet — this only asks the gate what the terms would be.
      const r = await api('/markets/draft', { method: 'POST', body: { text } });
      if (r.approved) { S.draft2 = r; S.gateError = null; }
      else S.gateError = r;
      render();
    } catch (err) { S.gateError = { reason: err.message }; render(); }
  });

  on('#dback', 'click', () => { S.draft2 = null; render(); });

  on('#dconfirm', 'click', async e => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = 'Posting…';
    try {
      const r = await api('/markets', {
        method: 'POST',
        body: {
          draftId: S.draft2.draftId,
          tipNim: Number(S.pool.nim) || 0,
          tipWinners: Number(S.pool.winners) || 0,
        },
      });
      if (r.approved) {
        S.composing = false; S.draft2 = null; S.gateError = null; S.draft = '';
        S.pool = { nim: '', winners: '' }; S.poolOpen = false;
        // A first post can complete a quest and pay out points.
        S.me = await api('/me').catch(() => S.me);
      } else S.gateError = r;
      render();
    } catch (err) {
      S.draft2 = null;
      S.gateError = { reason: err.message };
      render();
    }
  });

  // Paying a tip pool: one transaction per winner, each approved in Nimiq Pay.
  // The marker the server hands back is what proves on chain which debt this
  // settles, so it has to travel with the transaction.
  on('[data-pay]', 'click', async e => {
    e.stopPropagation();
    const btn = e.currentTarget;
    const id = Number(btn.dataset.pay);
    const owed = S.owed?.find(a => a.id === id);
    if (!owed) return;

    const before = btn.textContent;
    btn.disabled = true; btn.textContent = 'Confirm…';
    try {
      const hash = await wallet.sendNim(owed.address, owed.amount_nim, owed.marker);
      await api('/payouts/' + id, { method: 'POST', body: { txHash: hash } });
      render();
    } catch (err) {
      btn.disabled = false; btn.textContent = before;
      alert(err.message);
    }
  });

  on('#tipcancel', 'click', () => { S.tipTarget = null; render(); });

  on('#tipsend', 'click', async () => {
    const t = S.tipTarget;
    const toUsername = (t.locked ? t.username : el.querySelector('#tipuser')?.value.trim()) || '';
    const amount = Number(el.querySelector('#tipamount')?.value);

    if (!toUsername) { S.tipTarget = { ...t, error: 'Enter a username' }; return render(); }
    if (toUsername === S.me.username) { S.tipTarget = { ...t, error: 'You cannot tip yourself' }; return render(); }
    if (!(amount > 0)) { S.tipTarget = { ...t, username: toUsername, error: 'Enter an amount' }; return render(); }

    S.tipTarget = { ...t, username: toUsername, amount, sending: true, error: null };
    render();
    try {
      const profile = await api('/users/' + encodeURIComponent(toUsername));
      if (!profile.address) throw new Error('That account has no wallet address');

      // The marker is what lets the server match this payment to this recipient on
      // chain, so it has to go out with the transaction, not after it.
      const hash = await wallet.sendNim(profile.address, amount, `predtube tip @${toUsername.toLowerCase()}`);
      await api('/tips', { method: 'POST', body: { toUsername, amountNim: amount, txHash: hash } });

      S.tipTarget = null;
      alert(`Sent ${amount} NIM to @${toUsername} — confirming on chain.`);
      render();
    } catch (err) {
      S.tipTarget = { ...S.tipTarget, sending: false, error: err.message };
      render();
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
async function signIn({ username, avatar } = {}) {
  const body = { address: wallet.state.address, deviceHash: wallet.state.deviceHash };
  if (username) body.username = username;
  if (Number.isInteger(avatar)) body.avatar = avatar;

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
