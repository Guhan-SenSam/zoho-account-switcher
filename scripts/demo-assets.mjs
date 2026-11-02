// Content and static artwork for scripts/record-demo.mjs: the demo accounts and
// their (made-up) inboxes, the fake cursor injected into the popup page, and the
// HTML for the frame the two recorded panes are composited into.

/** Saved accounts in display order. `user` is what is typed into the fake sign-in form. */
export const ACCOUNTS = [
  { name: 'Work', user: 'alex@northwind.example' },
  { name: 'Personal', user: 'alex.rivera@homemail.example' },
  { name: 'Client – Acme', user: 'alex@acme.example' },
];

/** Fake Zoho "pretty" mode profiles (see startFakeZoho({ pretty })). Neutral, generic content. */
export const PRETTY_USERS = {
  'alex@northwind.example': {
    name: 'Alex Rivera',
    org: 'Northwind Traders',
    color: '#1565c0',
    initials: 'AR',
    inbox: [
      { from: 'Priya Shah', subject: 'Q4 roadmap review', snippet: 'Agenda attached, add your items by Thursday', time: '9:41 AM', unread: true },
      { from: 'Build bot', subject: 'Release 4.2 passed all checks', snippet: '312 tests green on main', time: '8:15 AM', unread: true },
      { from: 'Marco Diaz', subject: 'Design review moved to Thu', snippet: 'Same room, 2 pm. Bring the new mockups', time: '7:52 AM', unread: true },
      { from: 'People Ops', subject: 'Benefits enrollment closes Friday', snippet: 'Confirm your selections in the portal', time: 'Mon' },
      { from: 'Lena Fischer', subject: 'Re: Vendor shortlist', snippet: 'Two of the three can start next month', time: 'Oct 30' },
      { from: 'Facilities', subject: 'Badge photos this week', snippet: 'Drop by reception any time before 4 pm', time: 'Oct 29' },
    ],
  },
  'alex.rivera@homemail.example': {
    name: 'Alex Rivera',
    org: 'Personal',
    color: '#c62828',
    initials: 'AR',
    inbox: [
      { from: 'SkyHop Travel', subject: 'Your flight to Lisbon is confirmed', snippet: 'Sat 14 Nov, seat 12A', time: '10:02 AM', unread: true },
      { from: 'Book club', subject: 'November pick: The Overstory', snippet: "We meet at Sam's on the 20th", time: '8:47 AM', unread: true },
      { from: 'Mom', subject: 'Photos from Saturday', snippet: '12 photos, the cake came out great!', time: 'Yesterday' },
      { from: 'City Library', subject: '2 items due soon', snippet: 'Renew online before 5 Nov', time: 'Sat' },
      { from: 'Running club', subject: 'Sunday 10K route', snippet: 'Meet at the north gate, 7:30 am', time: 'Oct 30' },
      { from: 'Jordan', subject: 'Dinner next week?', snippet: 'Tue or Wed works for us', time: 'Oct 28' },
    ],
  },
  'alex@acme.example': {
    name: 'Alex Rivera',
    org: 'Acme Corp · guest',
    color: '#2e7d32',
    initials: 'AR',
    inbox: [
      { from: 'Dana Okafor', subject: 'Kickoff notes: Acme rollout', snippet: 'Thanks for today! Owners and dates inside', time: '11:20 AM', unread: true },
      { from: 'Acme IT', subject: 'Guest access approved', snippet: 'You can now open the Rollout workspace', time: '9:05 AM', unread: true },
      { from: 'Dana Okafor', subject: 'Contract draft v3', snippet: 'Legal signed off on sections 1 to 4', time: 'Yesterday' },
      { from: 'Acme PMO', subject: 'Weekly status, week 44', snippet: 'On track, two risks flagged', time: 'Fri' },
      { from: 'Ravi Menon', subject: 'Data migration plan', snippet: 'Draft attached for your review', time: 'Thu' },
      { from: 'Acme IT', subject: 'Reminder: turn on 2-step sign-in', snippet: 'Required for guests by 15 Nov', time: 'Oct 29' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Fake cursor. Runs inside the popup page (page.evaluate), so it must be
// self-contained. It is decoration only: the real click is a Playwright mouse
// event at the same point.

export function installCursor({ x, y }) {
  const style = document.createElement('style');
  style.textContent = `
    #demo-cursor, #demo-ring { position: fixed; left: 0; top: 0; pointer-events: none; z-index: 2147483647; }
    #demo-cursor { width: 22px; height: 28px; will-change: transform;
      filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); }
    #demo-cursor svg { display: block; transition: transform .12s ease-out; transform-origin: 3px 2px; }
    #demo-cursor.down svg { transform: scale(.86); }
    #demo-ring { width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
      background: rgba(79,70,229,.22); border: 2px solid rgba(79,70,229,.6); opacity: 0; }
    #demo-ring.go { animation: demo-ring .6s ease-out; }
    @keyframes demo-ring { 0% { opacity: 1; transform: scale(.35); } 100% { opacity: 0; transform: scale(1.5); } }
  `;
  const ring = document.createElement('div');
  ring.id = 'demo-ring';
  const cursor = document.createElement('div');
  cursor.id = 'demo-cursor';
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '28');
  svg.setAttribute('viewBox', '0 0 22 28');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M3 2 L3 22.5 L8 17.8 L11.4 25.6 L15 24 L11.6 16.4 L18.4 16.4 Z');
  path.setAttribute('fill', '#111827');
  path.setAttribute('stroke', '#ffffff');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  cursor.append(svg);
  document.documentElement.append(style, ring, cursor);

  // The arrow's tip is at (3, 2) in the SVG.
  const place = (px, py) => { cursor.style.transform = `translate(${px - 3}px, ${py - 2}px)`; };
  place(x, y);
  window.__demoCursor = {
    moveTo(px, py, ms) {
      cursor.style.transition = `transform ${ms}ms cubic-bezier(.55,.05,.25,1)`;
      place(px, py);
      return new Promise((r) => setTimeout(r, ms));
    },
    press(px, py) {
      ring.style.left = `${px}px`;
      ring.style.top = `${py}px`;
      ring.classList.remove('go');
      void ring.offsetWidth; // restart the animation
      ring.classList.add('go');
      cursor.classList.add('down');
    },
    release() { cursor.classList.remove('down'); },
  };
}

// ---------------------------------------------------------------------------
// Composition frame: background, two window cards with title bars, and (in
// "mask" mode) white rounded rectangles where the recorded panes show through.

/**
 * @param {object} g  geometry in CSS px: { W, H, title, radius, left: {x,y,w,h}, right: {x,y,w,h} }
 *                    where left/right are the pane content rectangles
 * @param {'bg' | 'mask'} mode
 * @param {string} iconDataUrl  extension icon (data: URL)
 */
export function stageHtml(g, mode, iconDataUrl) {
  const card = (r) => `left:${r.x - 1}px;top:${r.y - g.title - 1}px;width:${r.w + 2}px;height:${r.h + g.title + 2}px`;
  const pane = (r) => `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
  if (mode === 'mask') {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${g.W}px;height:${g.H}px;background:#000;overflow:hidden}
.p{position:absolute;background:#fff;border-radius:0 0 ${g.radius - 1}px ${g.radius - 1}px}
</style></head><body><div class="p" style="${pane(g.left)}"></div><div class="p" style="${pane(g.right)}"></div></body></html>`;
  }
  const lock = '<svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true"><rect x="1" y="5" width="9" height="6.5" rx="1.6" fill="currentColor"/><path d="M3 5V3.6a2.5 2.5 0 0 1 5 0V5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{margin:0;width:${g.W}px;height:${g.H}px;overflow:hidden;background:#e8ebf0;
  font:12.5px/1 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",Arial,sans-serif;-webkit-font-smoothing:antialiased}
.card{position:absolute;border:1px solid #d3d8e0;border-radius:${g.radius}px;background:#fff;
  box-shadow:0 10px 28px rgba(30,41,59,.12),0 2px 5px rgba(30,41,59,.07)}
.bar{display:flex;align-items:center;gap:8px;height:${g.title}px;padding:0 12px;border-bottom:1px solid #e3e6eb;
  border-radius:${g.radius - 1}px ${g.radius - 1}px 0 0;background:#f4f5f8;color:#4b5563;font-weight:600}
.dots{display:flex;gap:6px;margin-right:6px}.dots i{width:10px;height:10px;border-radius:50%;background:#d5d9e0}
.url{display:flex;align-items:center;gap:6px;height:20px;padding:0 10px;border-radius:6px;background:#fff;
  border:1px solid #e3e6eb;color:#374151;font-weight:500}
.url svg{color:#9aa3af}
.muted{color:#8b93a1;font-weight:500}
.right{margin-left:auto}
.steps{position:absolute;margin:0;padding:0;list-style:none;color:#4b5563;font-size:13px;line-height:1.35}
.steps li{display:flex;align-items:center;gap:10px;margin-top:10px}
.steps b{display:inline-grid;place-items:center;flex:none;width:20px;height:20px;border-radius:50%;
  background:#fff;border:1px solid #d3d8e0;color:#4f46e5;font-size:11px;font-weight:700}
</style></head><body>
<ol class="steps" style="left:${g.left.x + 4}px;top:${g.left.y + g.left.h + 14}px;width:${g.left.w}px">
<li><b>1</b><span>Click an account in the popup</span></li>
<li><b>2</b><span>Its saved Zoho cookies are swapped in</span></li>
<li><b>3</b><span>Every open Zoho tab reloads as that account</span></li></ol>
<div class="card" style="${card(g.left)}"><div class="bar"><img src="${iconDataUrl}" width="16" height="16" alt="">
<span>Extension popup</span></div></div>
<div class="card" style="${card(g.right)}"><div class="bar"><span class="dots"><i></i><i></i><i></i></span>
<span class="url">${lock}<span>mail.zoho.com</span></span><span class="muted">Zoho tab</span>
<span class="muted right">demo server</span></div></div>
</body></html>`;
}
