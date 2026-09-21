import { getConfig } from "../config.js";
import { getModels } from "../runtimeConfig.js";
import { jevEnabled } from "../ai/jev.js";
import { playableGames } from "../games/registry.js";

/** Operator dashboard: codes, live sessions, one-click mint (loopback or ADMIN_TOKEN). */
export function dashboardHtml(): string {
  const cfg = getConfig();
  const m = getModels();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>jev-fc-buddy · operator</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:24px}
h1{font-size:18px;margin:0 0 12px}h2{font-size:15px;margin:24px 0 8px;color:#9ad}
table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #2a2f3a;text-align:left;font-size:13px}
code{background:#1b1f27;padding:2px 5px;border-radius:4px}button,input{font:inherit;padding:6px 10px;border-radius:6px;border:1px solid #39404f;background:#171a21;color:#eee}
button{cursor:pointer;background:#2d6cdf;border-color:#2d6cdf}.muted{color:#8a91a0}
</style></head><body>
<h1>jev-fc-buddy · operator</h1>
<div class="muted">games: ${playableGames().map((g) => g.id).join(", ") || "none (put a ROM in roms/)"} · Jev: ${jevEnabled() ? "on" : "off (TYPESAFE_API_KEY missing)"} · coach: ${m.coachModel} · chat: ${m.chatModel} · relay: ${cfg.relay.baseUrl} · ${cfg.coins.sessionMinutes} min / coin</div>
<h2>Mint a code</h2>
<form id="mint"><input name="coins" type="number" min="1" value="3" style="width:80px"> coins <input name="note" placeholder="note" style="width:240px"> <button>Mint</button> <span id="minted"></span></form>
<h2>Live sessions</h2><table id="sessions"><tr><th>session</th><th>game</th><th>started</th><th>expires</th><th>ended</th></tr></table>
<h2>Codes</h2><table id="codes"><tr><th>code</th><th>coins</th><th>used</th><th>order</th><th>buyer</th><th>created</th><th>note</th></tr></table>
<script>
const h={};const t=new URLSearchParams(location.search).get('token');if(t)h.authorization='Bearer '+t;
async function load(){
  const c=await (await fetch('/api/admin/codes',{headers:h})).json();
  document.getElementById('codes').innerHTML='<tr><th>code</th><th>coins</th><th>used</th><th>order</th><th>buyer</th><th>created</th><th>note</th></tr>'+(c.codes||[]).map(x=>'<tr><td><code>'+x.code+'</code></td><td>'+x.coins+'</td><td>'+x.used+'</td><td>'+x.orderId+'</td><td>'+(x.buyer||'')+'</td><td>'+x.createdAt.slice(0,16).replace('T',' ')+'</td><td>'+(x.note||'')+'</td></tr>').join('');
  const s=await (await fetch('/api/admin/sessions',{headers:h})).json();
  document.getElementById('sessions').innerHTML='<tr><th>session</th><th>game</th><th>started</th><th>expires</th><th>ended</th></tr>'+(s.sessions||[]).map(x=>'<tr><td>'+x.sessionId+'</td><td>'+x.game.id+'</td><td>'+x.startedAt.slice(11,19)+'</td><td>'+x.expiresAt.slice(11,19)+'</td><td>'+(x.ended||'')+'</td></tr>').join('');
}
document.getElementById('mint').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);const r=await (await fetch('/api/admin/codes',{method:'POST',headers:{...h,'content-type':'application/json'},body:JSON.stringify({coins:Number(f.get('coins')),note:f.get('note')})})).json();document.getElementById('minted').innerHTML=r.code?'<code>'+r.code+'</code> → <a href="'+r.playUrl+'" target="_blank">'+r.playUrl+'</a>':JSON.stringify(r);load();};
load();setInterval(load,10000);
</script></body></html>`;
}
