/**
 * Operator dashboard, served at ADMIN_PATH. A single static page: it asks for ADMIN_TOKEN once
 * (kept in this browser's localStorage) and calls /api/admin/* with it as a bearer. Shows the relay
 * spend (OpenRouter key usage), coin/order/revenue counters, live sessions, codes and orders, and
 * lets the operator change the minutes per coin and mint codes.
 */
export function dashboardHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Jev FC Buddy · operator</title>
<style>
:root{--bg:#0b0d12;--panel:#12151d;--line:#222836;--text:#e8eaf0;--muted:#8a92a6;--ok:#7ee787;--warn:#ffbf47;--bad:#ff7b7b;--accent:#2d6cdf;--jev:#4fd1ff}
*{box-sizing:border-box}body{font:14px/1.5 Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:22px 26px;max-width:1280px}
h1{font-size:18px;margin:0 0 4px;letter-spacing:.06em}h2{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:26px 0 10px}
.sub{color:var(--muted);font-size:12px}code{background:#1b1f27;padding:2px 6px;border-radius:4px;font-size:12.5px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.card .k{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}.card .v{font-size:22px;font-weight:700;margin-top:2px}.card .s{font-size:12px;color:var(--muted)}
table{border-collapse:collapse;width:100%;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
td,th{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;font-size:13px;vertical-align:top}th{color:var(--muted);font-weight:600;font-size:11px;letter-spacing:.06em;text-transform:uppercase}tr:last-child td{border-bottom:0}
button,input{font:inherit;padding:7px 11px;border-radius:8px;border:1px solid #39404f;background:#171a21;color:#eee}button{cursor:pointer;background:var(--accent);border-color:var(--accent);font-weight:600}button.ghost{background:transparent;border-color:var(--line)}
form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.muted{color:var(--muted)}
#login{max-width:520px;margin:60px auto;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:26px}#login input{width:100%;margin:10px 0}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;background:#1b1f27}
</style></head><body>
<div id="login" hidden><h1>Operator sign-in</h1><p class="sub">Paste the ADMIN_TOKEN from the server's .env.local. It stays in this browser only.</p><form id="loginForm"><input id="tok" type="password" placeholder="ADMIN_TOKEN" autocomplete="off"><button>Sign in</button></form><p id="loginErr" class="bad" hidden></p></div>
<div id="app" hidden>
<div class="row"><div><h1>JEV FC BUDDY · OPERATOR</h1><div id="meta" class="sub"></div></div><div><span id="clock" class="sub"></span> <button class="ghost" id="refresh">Refresh</button> <button class="ghost" id="logout">Sign out</button></div></div>

<h2>Spend (relay key, USD)</h2>
<div class="cards" id="spend"></div>
<div id="spendErr" class="sub"></div>

<h2>Business</h2>
<div class="cards" id="biz"></div>

<h2>Cost per coin (what one play costs you)</h2>
<div class="cards" id="perCoin"></div>
<p id="perCoinNote" class="sub"></p>
<table id="windows"></table>

<h2>Settings</h2>
<form id="settings"><label>Minutes of play per coin <input id="minutes" type="number" min="1" max="1440" step="1" style="width:90px"></label><button>Save</button><button type="button" class="ghost" id="minutesReset">Use .env default</button><span id="settingsMsg" class="sub"></span></form>
<p class="sub">Applies to coins inserted from now on; a window that is already running keeps its length. A player may leave and come back for free while their window is running (now − insert time &lt; minutes).</p>

<h2>Mint a code</h2>
<form id="mint"><input name="coins" type="number" min="1" value="1" style="width:80px"> coins <input name="note" placeholder="note (optional)" style="width:260px"><button>Mint</button><span id="minted"></span></form>

<h2>Live sessions</h2><table id="sessions"></table>
<h2>Orders (Termix)</h2><table id="orders"></table>
<h2>Codes</h2><table id="codes"></table>
</div>
<script>
const $=id=>document.getElementById(id);
const KEY='jevbuddy.adminToken';
let token=localStorage.getItem(KEY)||'';
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const usd=v=>v==null?'—':'$'+Number(v).toFixed(v<1?4:2);
const when=s=>s?s.slice(0,16).replace('T',' ')+'Z':'';
const ago=s=>{if(!s)return '';const d=(Date.now()-Date.parse(s))/1000;return d<60?Math.round(d)+'s':d<3600?Math.round(d/60)+'m':d<86400?Math.round(d/3600)+'h':Math.round(d/86400)+'d'};
async function api(path,body){
  const r=await fetch(path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  if(r.status===401){signOut('Wrong or missing token');throw new Error('unauthorized')}
  const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j;
}
function signOut(msg){localStorage.removeItem(KEY);token='';$('app').hidden=true;$('login').hidden=false;if(msg){$('loginErr').hidden=false;$('loginErr').textContent=msg}}
$('loginForm').onsubmit=e=>{e.preventDefault();token=$('tok').value.trim();localStorage.setItem(KEY,token);$('loginErr').hidden=true;boot()};
$('logout').onclick=()=>signOut('');$('refresh').onclick=()=>load();
function card(k,v,s,cls){return '<div class="card"><div class="k">'+esc(k)+'</div><div class="v '+(cls||'')+'">'+v+'</div><div class="s">'+(s||'')+'</div></div>'}
async function load(){
  const o=await api('/api/admin/overview');
  $('clock').textContent='updated '+new Date(o.now).toLocaleTimeString();
  $('meta').innerHTML='API <code>'+esc(o.urls.api)+'</code> · play page <code>'+esc(o.urls.play)+'</code> · games: '+esc(o.games.join(', ')||'none')+' · chat model <code>'+esc(o.models.chat)+'</code> · Jev '+(o.models.jev?'<span class="ok">on</span> ('+esc(o.models.jev)+')':'<span class="bad">off</span>')+' · Termix hosting '+(o.hosting.enabled?'<span class="ok">on</span> ('+esc(o.hosting.chain)+', agent '+esc(o.hosting.agentId)+')':'<span class="warn">off</span>');
  const sp=o.spend;
  $('spend').innerHTML=card('Today',usd(sp.today))+card('This week',usd(sp.week))+card('This month',usd(sp.month))+card('All time',usd(sp.total))+card('Credits left',usd(sp.creditsLeft),sp.credits!=null?'of '+usd(sp.credits)+' bought':'',sp.creditsLeft!=null&&sp.creditsLeft<1?'bad':'ok');
  $('spendErr').innerHTML=sp.error?'<span class="warn">Spend unavailable: '+esc(sp.error)+'</span> ('+esc(sp.baseUrl)+')':'Source: '+esc(sp.baseUrl)+' key usage, refreshed every minute. Jev and buyer chat both bill to this key.';
  const c=o.coins,od=o.orders,se=o.sessions,st=o.settings;
  $('biz').innerHTML=card('Revenue',od.revenue.toFixed(2)+' '+esc(od.currency),od.paid+' paid order'+(od.paid===1?'':'s')+(od.failed?', <span class="bad">'+od.failed+' failed</span>':''),'ok')+card('Coins sold / minted',c.used+' / '+c.minted,c.codes+' codes · '+c.usedToday+' inserted in 24h')+card('Live sessions',se.live,c.activeWindows+' open window'+(c.activeWindows===1?'':'s')+' · '+se.openedSinceStart+' since restart')+card('Per coin',st.sessionMinutes+' min',st.price+' '+esc(st.currency)+' → '+st.coinsPerDollar+' coin'+(st.coinsPerDollar===1?'':'s'));
  const pc=o.perCoin;const m4=v=>v==null?'—':'$'+Number(v).toFixed(4);const mins=v=>v==null?'—':Number(v).toFixed(1)+' min';
  $('perCoin').innerHTML=card('Avg cost per coin',m4(pc.avgCostPerCoin),pc.measuredCoins+' coin'+(pc.measuredCoins===1?'':'s')+' measured','ok')+card('Per played minute',m4(pc.avgCostPerPlayMinute),'avg play '+mins(pc.avgPlayMinutes)+' per coin')+card('Jev calls / min',pc.avgJevCallsPerMinute==null?'—':pc.avgJevCallsPerMinute.toFixed(0),pc.jevCalls+' calls · '+(pc.inputTokens/1e6).toFixed(2)+'M in / '+(pc.outputTokens/1e6).toFixed(2)+'M out tokens')+card('Bill ÷ coins used',m4(pc.keySpendPerCoinUsed),'all key spend / every coin inserted','warn');
  $('perCoinNote').textContent='Estimate = Jev tokens × $'+pc.priceInPerM+'/M in, $'+pc.priceOutPerM+'/M out (JEV_PRICE_*_PER_M), booked when a browser session ends. "Bill ÷ coins" is the all-time usage of the relay key divided by all coins ever inserted, so it also carries anything else the key paid for.';
  if(document.activeElement!==$('minutes'))$('minutes').value=st.sessionMinutes;
  $('minutesReset').textContent='Use .env default ('+st.defaultSessionMinutes+')';
  const [s,cd,or,wd]=await Promise.all([api('/api/admin/sessions'),api('/api/admin/codes'),api('/api/admin/orders'),api('/api/admin/windows')]);
  $('windows').innerHTML='<tr><th>coin inserted</th><th>code</th><th>game</th><th>window</th><th>played</th><th>entries</th><th>Jev calls</th><th>tokens in / out</th><th>est. cost</th></tr>'+((wd.windows||[]).slice(0,40).map(w=>{const u=w.usage||{};return '<tr><td>'+when(w.startedAt)+'</td><td><code>'+esc(w.code)+'</code></td><td>'+esc(w.gameId)+'</td><td>'+(w.expiresAt&&Date.parse(w.expiresAt)>Date.now()&&w.reason!=='time is up'?'<span class="ok">open</span>':'<span class="muted">'+esc(w.reason||'closed')+'</span>')+'</td><td>'+(u.playSeconds!=null?(u.playSeconds/60).toFixed(1)+' min':'—')+'</td><td>'+(w.entries||1)+'</td><td>'+(u.jevCalls??'—')+'</td><td>'+(u.inputTokens!=null?u.inputTokens.toLocaleString()+' / '+u.outputTokens.toLocaleString():'—')+'</td><td>'+(u.estCost!=null?'$'+u.estCost.toFixed(4):'—')+'</td></tr>'}).join('')||'<tr><td class="muted" colspan="9">no coins inserted yet</td></tr>');
  $('sessions').innerHTML='<tr><th>session</th><th>code</th><th>game</th><th>started</th><th>expires</th><th>coins left</th><th>state</th></tr>'+((s.sessions||[]).map(x=>'<tr><td><code>'+esc(x.sessionId)+'</code></td><td><code>'+esc(x.windowId.slice(0,8))+'</code></td><td>'+esc(x.game.id)+'</td><td>'+when(x.startedAt)+'</td><td>'+when(x.expiresAt)+'</td><td>'+x.remaining+'</td><td>'+(x.ended?'<span class="muted">'+esc(x.ended)+'</span>':'<span class="ok">playing</span>')+'</td></tr>').join('')||'<tr><td class="muted" colspan="7">none</td></tr>');
  $('orders').innerHTML='<tr><th>order</th><th>status</th><th>price</th><th>buyer</th><th>code</th><th>updated</th><th>error</th></tr>'+((or.orders||[]).map(j=>'<tr><td><code>'+esc(j.orderId)+'</code></td><td><span class="pill '+(j.status==='failed'?'bad':j.status==='settled'||j.status==='delivered'?'ok':'warn')+'">'+esc(j.status)+'</span></td><td>'+esc(j.price||'')+' '+esc(j.currency||'')+'</td><td>'+esc(j.buyer||'')+'</td><td><code>'+esc(j.code||'—')+'</code></td><td>'+ago(j.updatedAt)+' ago</td><td class="bad">'+esc((j.error||'').slice(0,120))+'</td></tr>').join('')||'<tr><td class="muted" colspan="7">no orders yet</td></tr>');
  $('codes').innerHTML='<tr><th>code</th><th>coins</th><th>used</th><th>window</th><th>order</th><th>buyer</th><th>created</th><th>note</th></tr>'+((cd.codes||[]).map(x=>'<tr><td><code>'+esc(x.code)+'</code></td><td>'+x.coins+'</td><td>'+x.used+'</td><td>'+(x.revokedAt?'<span class="bad">revoked '+when(x.revokedAt)+(x.replacedBy?' → '+esc(x.replacedBy):'')+'</span>':x.active?'<span class="ok">open until '+when(x.active)+'</span>':'<span class="muted">—</span>')+'</td><td>'+esc(x.orderId)+'</td><td>'+esc(x.buyer||'')+'</td><td>'+when(x.createdAt)+'</td><td>'+esc(x.note||'')+'</td></tr>').join('')||'<tr><td class="muted" colspan="8">no codes yet</td></tr>');
}
$('settings').onsubmit=async e=>{e.preventDefault();try{const r=await api('/api/admin/settings',{sessionMinutes:Number($('minutes').value)});$('settingsMsg').textContent='Saved: '+r.sessionMinutes+' min per coin';load()}catch(err){$('settingsMsg').textContent=err.message}};
$('minutesReset').onclick=async()=>{try{const r=await api('/api/admin/settings',{sessionMinutes:null});$('settingsMsg').textContent='Back to .env default: '+r.sessionMinutes+' min';load()}catch(err){$('settingsMsg').textContent=err.message}};
$('mint').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{const r=await api('/api/admin/codes',{coins:Number(f.get('coins')),note:f.get('note')});$('minted').innerHTML='<code>'+esc(r.code)+'</code> → <a href="'+esc(r.playUrl)+'" target="_blank" style="color:var(--jev)">'+esc(r.playUrl)+'</a>';load()}catch(err){$('minted').textContent=err.message}};
let timer;
async function boot(){if(!token){$('login').hidden=false;return}try{await load();$('login').hidden=true;$('app').hidden=false;clearInterval(timer);timer=setInterval(()=>load().catch(()=>{}),15000)}catch(err){if(err.message!=='unauthorized'){$('loginErr').hidden=false;$('loginErr').textContent=err.message;$('login').hidden=false}}}
boot();
</script></body></html>`;
}
