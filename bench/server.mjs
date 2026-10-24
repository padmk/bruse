// Benchmark site: deterministic task pages served on two origins (the second hosts the cross-origin
// payment frame). Submissions and page events are recorded in memory and read back through /api/log.
import http from "node:http";

export const PORT_A = 47901;
export const PORT_B = 47902;
export const ORIGIN_A = `http://127.0.0.1:${PORT_A}`;
export const ORIGIN_B = `http://localhost:${PORT_B}`;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const customers = ["Nowak Logistics", "Kowalski Studio", "Baltic Foods", "Wisła Tech", "Orion Media", "Tatra Sport", "Mazur Auto", "Delta Print"];
const statuses = ["Opłacone", "Wysłane", "Zwrot", "Anulowane", "Oczekuje"];
const r1 = rng(7);
export const orders = Array.from({ length: 250 }, (_, i) => ({
  id: `ZM-${String(10400 + i)}`,
  customer: customers[Math.floor(r1() * customers.length)],
  status: statuses[Math.floor(r1() * statuses.length)],
  amount: Math.round((40 + r1() * 4960) * 100) / 100,
  date: `2026-${String(1 + Math.floor(r1() * 9)).padStart(2, "0")}-${String(1 + Math.floor(r1() * 28)).padStart(2, "0")}`,
}));

const categories = ["Monitory", "Klawiatury", "Myszy", "Laptopy", "Słuchawki", "Kamery"];
const r2 = rng(11);
export const products = Array.from({ length: 120 }, (_, i) => {
  const category = categories[i % categories.length];
  const inches = category === "Monitory" ? [24, 27, 32, 34][Math.floor(r2() * 4)] : null;
  return {
    id: i + 1,
    sku: `SKU-${(73000 + i * 37).toString(36).toUpperCase()}`,
    category,
    name: `${category.slice(0, -1)} ${["Pro", "Air", "Max", "One", "Neo", "Edge"][Math.floor(r2() * 6)]} ${100 + Math.floor(r2() * 900)}${inches ? ` ${inches}"` : ""}`,
    inches,
    price: Math.round(149 + r2() * 4800),
  };
});

const log = { signups: [], payments: [], sessions: [], downloads: 0 };

const css = `body{font-family:system-ui,sans-serif;margin:0;color:#1d2327;background:#f6f7f7}
header{background:#1d2327;color:#fff;padding:14px 32px;font-weight:600}
main{max-width:1100px;margin:24px auto;padding:0 32px}
table{border-collapse:collapse;width:100%;background:#fff}td,th{border-bottom:1px solid #e2e4e7;padding:6px 10px;text-align:left;font-size:14px}
label{display:block;margin:12px 0 4px;font-weight:600}input,select{padding:7px;font-size:15px;min-width:260px}
button{padding:8px 16px;font-size:15px;margin:4px 6px 4px 0;cursor:pointer}.card{background:#fff;padding:20px;border-radius:8px;margin:12px 0}
.toolbar{display:flex;flex-wrap:wrap;gap:6px;background:#fff;padding:10px;border-radius:8px}.ok{color:#08702e;font-weight:700}`;

const page = (title, body, script = "") =>
  `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head>` +
  `<body><header>Panel firmy</header><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;

function ordersPage() {
  const rows = orders
    .map((o) => `<tr><td>${o.id}</td><td>${o.date}</td><td>${o.customer}</td><td>${o.status}</td><td>${o.amount.toFixed(2).replace(".", ",")} zł</td></tr>`)
    .join("");
  return page("Zamówienia", `<h1>Zamówienia</h1><table><thead><tr><th>Numer</th><th>Data</th><th>Klient</th><th>Status</th><th>Kwota</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function signupPage() {
  return page(
    "Nowe konto firmowe",
    `<h1>Nowe konto firmowe</h1><div class="card" id="wizard"></div>`,
    `const data={};let step=1;const w=document.getElementById('wizard');
function render(){
 if(step===1)w.innerHTML='<h2>Krok 1 z 3: Firma</h2><label for=n>Nazwa firmy</label><input id=n><label for=t>NIP</label><input id=t><label for=e>E-mail do faktur</label><input id=e type=email><p id=err style="color:#b32d2e"></p><button id=next>Dalej</button>';
 if(step===2)w.innerHTML='<h2>Krok 2 z 3: Plan</h2><fieldset><legend>Plan</legend><label><input type=radio name=plan value=start> Start</label><label><input type=radio name=plan value=team> Team</label><label><input type=radio name=plan value=enterprise> Enterprise</label></fieldset><label for=s>Liczba stanowisk</label><input id=s type=number min=1><label for=b>Okres rozliczeniowy</label><select id=b><option value="">Wybierz</option><option value=monthly>Miesięczny</option><option value=yearly>Roczny</option></select><label for=d>Data startu</label><input id=d type=date><p id=err style="color:#b32d2e"></p><button id=back>Wstecz</button><button id=next>Dalej</button>';
 if(step===3)w.innerHTML='<h2>Krok 3 z 3: Podsumowanie</h2><p>'+data.company+', plan '+data.plan+', stanowiska: '+data.seats+'</p><label><input type=checkbox id=terms> Akceptuję regulamin</label><p id=err style="color:#b32d2e"></p><button id=back>Wstecz</button><button id=next>Załóż konto</button>';
 const back=document.getElementById('back');if(back)back.onclick=()=>{step--;render()};
 document.getElementById('next').onclick=next;
}
async function next(){
 const err=document.getElementById('err');
 if(step===1){const n=v('n'),t=v('t'),e=v('e');if(!n||!/^\\d{10}$/.test(t.replace(/-/g,''))||!e.includes('@')){err.textContent='Uzupełnij poprawnie wszystkie pola (NIP: 10 cyfr).';return}Object.assign(data,{company:n,nip:t.replace(/-/g,''),email:e})}
 if(step===2){const p=document.querySelector('input[name=plan]:checked');if(!p||!v('s')||!v('b')||!v('d')){err.textContent='Wybierz plan i uzupełnij wszystkie pola.';return}Object.assign(data,{plan:p.value,seats:Number(v('s')),billing:v('b'),start:v('d')})}
 if(step===3){if(!document.getElementById('terms').checked){err.textContent='Zaakceptuj regulamin.';return}
  const r=await fetch('/api/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const j=await r.json();
  w.innerHTML='<h2 class=ok>Konto utworzone</h2><p>Numer klienta: <strong>'+j.code+'</strong></p>';return}
 step++;render();
}
function v(id){return document.getElementById(id).value.trim()}
render();`,
  );
}

function catalogPage(url) {
  const q = (url.searchParams.get("q") || "").toLowerCase();
  const cat = url.searchParams.get("kategoria") || "";
  const pageNo = Math.max(1, Number(url.searchParams.get("strona") || 1));
  const list = products.filter((p) => (!cat || p.category === cat) && (!q || p.name.toLowerCase().includes(q)));
  const pages = Math.max(1, Math.ceil(list.length / 8));
  const slice = list.slice((pageNo - 1) * 8, pageNo * 8);
  const options = ['<option value="">Wszystkie kategorie</option>', ...categories.map((c) => `<option${c === cat ? " selected" : ""}>${c}</option>`)].join("");
  const items = slice.map((p) => `<div class="card"><a href="/produkt?id=${p.id}">${p.name}</a><div>${p.price} zł</div></div>`).join("") || "<p>Brak wyników.</p>";
  const nav = Array.from({ length: pages }, (_, i) => (i + 1 === pageNo ? `<strong>${i + 1}</strong>` : `<a href="/katalog?${new URLSearchParams({ q, kategoria: cat, strona: i + 1 })}">${i + 1}</a>`)).join(" ");
  return page(
    "Katalog",
    `<h1>Katalog sprzętu</h1><form action="/katalog"><label for=q>Szukaj</label><input id=q name=q value="${q}"><label for=k>Kategoria</label><select id=k name=kategoria>${options}</select> <button>Filtruj</button></form><p>Wyników: ${list.length}. Sortowanie: od najnowszych.</p>${items}<nav aria-label="Strony">Strony: ${nav}</nav>`,
  );
}

function productPage(url) {
  const p = products.find((x) => x.id === Number(url.searchParams.get("id")));
  if (!p) return page("Brak", "<p>Nie ma takiego produktu.</p>");
  return page(p.name, `<h1>${p.name}</h1><div class="card"><p>Kategoria: ${p.category}</p><p>Cena: ${p.price} zł</p>${p.inches ? `<p>Przekątna: ${p.inches} cali</p>` : ""}<p>Kod SKU: <strong>${p.sku}</strong></p></div><a href="/katalog">Wróć do katalogu</a>`);
}

function dashboardPage() {
  const buttons = [
    ["Odśwież", "document.getElementById('out').textContent='Odświeżono'"],
    ["Eksportuj PDF", "document.getElementById('out').textContent='Przygotowano PDF'"],
    ["Archiwizuj", "null.archive()"],
    ["Pokaż wykres", "document.getElementById('out').textContent='Wykres gotowy'"],
    ["Synchronizuj", "fetch('/api/sync').then(r=>{if(!r.ok)console.error('Synchronizacja nieudana: HTTP '+r.status)})"],
    ["Udostępnij", "document.getElementById('out').textContent='Skopiowano link'"],
    ["Duplikuj", "document.getElementById('out').textContent='Zduplikowano'"],
    ["Ustawienia", "document.getElementById('out').textContent='Otwarto ustawienia'"],
  ];
  const html = buttons.map(([l], i) => `<button id="b${i}">${l}</button>`).join("");
  const js = buttons.map(([, code], i) => `document.getElementById('b${i}').onclick=()=>{${code}};`).join("\n");
  return page("Pulpit", `<h1>Pulpit raportów</h1><div class="toolbar" role="toolbar" aria-label="Narzędzia">${html}</div><p id="out" role="status"></p>`, js);
}

function checkoutPage() {
  return page("Płatność", `<h1>Płatność za zamówienie ZM-10777</h1><p>Do zapłaty: 1 249,00 zł</p><iframe title="Bramka płatności" src="${ORIGIN_B}/bramka" style="width:520px;height:420px;border:1px solid #ccc;background:#fff"></iframe>`);
}

function gatewayPage() {
  return page(
    "Bramka",
    `<h2>Bezpieczna płatność</h2><label for=c>Numer karty</label><input id=c inputmode=numeric><label for=x>Data ważności (MM/RR)</label><input id=x><label for=v>CVC</label><input id=v><label for=h>Imię i nazwisko na karcie</label><input id=h><p id=err style="color:#b32d2e"></p><button id=pay>Zapłać</button><p id=res role=status></p>`,
    `document.getElementById('pay').onclick=async()=>{const g=id=>document.getElementById(id).value.trim();
if(g('c').replace(/\\s/g,'').length!==16||!/^\\d\\d\\/\\d\\d$/.test(g('x'))||g('v').length!==3||!g('h')){document.getElementById('err').textContent='Sprawdź dane karty.';return}
const r=await fetch('/api/pay',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({card:g('c').replace(/\\s/g,''),exp:g('x'),cvc:g('v'),holder:g('h')})});const j=await r.json();
document.getElementById('res').textContent='Płatność przyjęta. Identyfikator transakcji: '+j.id;}`,
  );
}

function notesPage() {
  return page(
    "Notatki",
    `<h1>Notatki</h1><p>Kod tej sesji: <strong id="code"></strong></p><textarea aria-label="Notatka" rows=6 cols=60>Szkic notatki, niezapisany.</textarea>`,
    `const c=Math.random().toString(36).slice(2,8).toUpperCase();document.getElementById('code').textContent=c;fetch('/api/session',{method:'POST',body:c});`,
  );
}

function articlePage() {
  const nav = Array.from({ length: 40 }, (_, i) => `<a href="#s${i}">Rozdział ${i + 1}</a>`).join(" · ");
  const body = Array.from({ length: 120 }, (_, i) => `<section id="s${i % 40}"><h2>Sekcja ${i + 1}</h2><p>Akapit ${i + 1} z opisem procesu wdrożenia, listą zależności i uwagami zespołu. </p><button>Rozwiń ${i + 1}</button></section>`).join("");
  return page("Dziennik zmian", `<nav aria-label="Spis treści">${nav}</nav><h1>Development never ends.</h1>${body}`);
}

export const reportCsv = "miesiac;przychod;koszty\n2026-07;182340,50;120410,00\n2026-08;175980,20;118300,75\n2026-09;201447,90;131020,10\n";

function reportsPage() {
  return page("Raporty", `<h1>Raporty</h1><p>Raport kwartalny jest dostępny tylko jako plik CSV.</p><a href="/raport.csv" download="raport-q3.csv"><button>Pobierz CSV</button></a>`);
}

const send = (res, status, type, body) => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};

async function readBody(req) {
  let b = "";
  for await (const chunk of req) b += chunk;
  return b;
}

function handler(origin) {
  return async (req, res) => {
    const url = new URL(req.url, origin);
    const html = (body) => send(res, 200, "text/html; charset=utf-8", body);
    const json = (status, body) => send(res, status, "application/json", JSON.stringify(body));
    switch (url.pathname) {
      case "/zamowienia": return html(ordersPage());
      case "/konto": return html(signupPage());
      case "/katalog": return html(catalogPage(url));
      case "/produkt": return html(productPage(url));
      case "/pulpit": return html(dashboardPage());
      case "/platnosc": return html(checkoutPage());
      case "/bramka": return html(gatewayPage());
      case "/notatki": return html(notesPage());
      case "/raporty": return html(reportsPage());
      case "/artykul": return html(articlePage());
      case "/raport.csv": log.downloads++; return send(res, 200, "text/csv; charset=utf-8", reportCsv);
      case "/api/sync": return json(500, { error: "sync failed" });
      case "/api/signup": {
        const data = JSON.parse(await readBody(req));
        const code = `KL-${4100 + log.signups.length}`;
        log.signups.push({ ...data, code, at: Date.now() });
        return json(200, { code });
      }
      case "/api/pay": {
        const data = JSON.parse(await readBody(req));
        const id = `TX-${(880000 + log.payments.length * 7).toString(36).toUpperCase()}`;
        log.payments.push({ ...data, id, at: Date.now() });
        return json(200, { id });
      }
      case "/api/session": log.sessions.push({ code: await readBody(req), at: Date.now() }); return json(200, {});
      case "/api/log": return json(200, log);
      case "/api/reset": Object.assign(log, { signups: [], payments: [], sessions: [], downloads: 0 }); return json(200, {});
      default: return send(res, 404, "text/plain", "not found");
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  http.createServer(handler(ORIGIN_A)).listen(PORT_A, "127.0.0.1");
  // The payment frame needs a different origin: another port on the localhost name.
  http.createServer(handler(ORIGIN_B)).listen(PORT_B, "127.0.0.1");
  console.log(`bench site on ${ORIGIN_A} and ${ORIGIN_B}`);
}
