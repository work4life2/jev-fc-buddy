// Play-page runtime config.
// Served by the game server itself this stays empty: the page talks to its own origin.
// When web/ is deployed elsewhere (Vercel), point it at the server over https, e.g.
//   window.JEV_API_BASE = "https://fc.172.104.55.67.sslip.io";
// and add that page's origin to ALLOWED_ORIGINS in the server's .env.local.
window.JEV_API_BASE = "";
