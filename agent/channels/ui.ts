import { defineChannel, GET } from "eve/channels";
import { randomUUID } from "node:crypto";

const agentRole = {
  name: "Compliance Compass",
  role: "Xero-connected compliance monitor",
  tagline: "Continuously checks a small business's books for risks, filing deadlines, and missing evidence before anything becomes a penalty.",
  onboardingQuestions: [
    { id: "businessType", label: "Business type", options: ["Limited company", "Sole trader", "Partnership"] },
    { id: "vatStatus", label: "VAT status", options: ["VAT registered", "Not VAT registered", "Unsure"] },
    { id: "companyStatus", label: "Company status", options: ["Trading", "Dormant", "Pre-revenue"] },
    { id: "payrollStatus", label: "Payroll status", options: ["Runs payroll", "No payroll", "Contractors only"] },
    { id: "industry", label: "Industry", options: ["Professional services", "Retail", "Hospitality", "Construction", "Other"] },
  ],
  filingDates: [
    { label: "VAT return", value: "Next quarter end" },
    { label: "Payroll RTI", value: "Monthly" },
    { label: "Companies House", value: "Annual confirmation" },
    { label: "Corporation Tax", value: "Year-end dependent" },
  ],
  issueLanes: [
    { label: "Upcoming", value: "4 deadlines", tone: "watch" },
    { label: "Missing evidence", value: "2 items", tone: "risk" },
    { label: "Ready", value: "7 checks", tone: "good" },
  ],
  prompts: [
    "Build my compliance calendar from these filing dates.",
    "List the evidence I should keep for this VAT period.",
    "Review Xero bookkeeping risks I should check weekly.",
    "Create a plain-English action plan for upcoming deadlines.",
  ],
} as const;

const xeroSessions = new Map<string, XeroSession>();
const xeroAuthorizeUrl = "https://login.xero.com/identity/connect/authorize";
const xeroTokenUrl = "https://identity.xero.com/connect/token";
const xeroConnectionsUrl = "https://api.xero.com/connections";
const xeroScopes = ["accounting.settings.read", "accounting.contacts.read", "offline_access"];

type XeroSession = {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantType?: string;
  connectedAt: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  organisation?: XeroOrganisation;
  contacts?: XeroContactsSummary;
};

type XeroOrganisation = {
  name?: string;
  legalName?: string;
  countryCode?: string;
  baseCurrency?: string;
  financialYearEndDay?: number;
  financialYearEndMonth?: number;
  organisationType?: string;
};

type XeroContactsSummary = { count?: number; sampleNames: string[] };

export default defineChannel({
  routes: [
    GET("/home", async () => html(renderHomePage())),
    GET("/ui", async (request) => html(renderPage(request))),
    GET("/xero/auth", async (request) => redirectToXeroAuth(request)),
    GET("/xero/callback", async (request) => xeroCallback(request)),
    GET("/xero/disconnect", async () => xeroDisconnect()),
  ],
});

function html(body: string) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function readEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  return value.replace(/^[ '\"]|[ '\"]$/g, "");
}

function redirectToXeroAuth(request: Request) {
  const clientId = readEnv("XERO_CLIENT_ID");
  if (!clientId) return new Response("Set XERO_CLIENT_ID before linking Xero.", { status: 500 });

  const origin = new URL(request.url).origin;
  const redirectUri = readEnv("XERO_REDIRECT_URI") ?? `${origin}/xero/callback`;
  const state = randomUUID();
  const authUrl = new URL(xeroAuthorizeUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", xeroScopes.join(" "));
  authUrl.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      location: authUrl.toString(),
      "set-cookie": serializeCookie("xero_oauth_state", state, { maxAge: 600, httpOnly: true }),
    },
  });
}

async function xeroCallback(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = getCookie(request, "xero_oauth_state");
  if (!code) return new Response("Xero callback reached without an authorization code.", { status: 400 });
  if (!state || !expectedState || state !== expectedState) return new Response("Xero callback state did not match this browser session.", { status: 400 });

  const origin = url.origin;
  const redirectUri = readEnv("XERO_REDIRECT_URI") ?? `${origin}/xero/callback`;
  const token = await exchangeXeroCode(code, redirectUri);
  const connections = await fetchXeroConnections(token.access_token);
  const connection = connections[0];
  if (!connection) return new Response("Xero connected, but no organisations were returned.", { status: 400 });

  const session: XeroSession = {
    id: randomUUID(),
    tenantId: connection.tenantId,
    tenantName: connection.tenantName,
    tenantType: connection.tenantType,
    connectedAt: new Date().toISOString(),
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
  session.organisation = await fetchXeroOrganisation(session);
  session.contacts = await fetchXeroContactsSummary(session);
  xeroSessions.set(session.id, session);

  return new Response(null, {
    status: 302,
    headers: [
      ["location", new URL("/ui?connected=1", origin).toString()],
      ["set-cookie", serializeCookie("xero_session", session.id, { maxAge: 60 * 60 * 8, httpOnly: true })],
      ["set-cookie", serializeCookie("xero_oauth_state", "", { maxAge: 0, httpOnly: true })],
    ],
  });
}

function xeroDisconnect() {
  return new Response(null, {
    status: 302,
    headers: { location: "/ui", "set-cookie": serializeCookie("xero_session", "", { maxAge: 0, httpOnly: true }) },
  });
}

async function exchangeXeroCode(code: string, redirectUri: string) {
  const clientId = readEnv("XERO_CLIENT_ID");
  const clientSecret = readEnv("XERO_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Set XERO_CLIENT_ID and XERO_CLIENT_SECRET.");
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  const response = await fetch(xeroTokenUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readXeroError(payload, "token exchange failed"));
  return payload as { access_token: string; refresh_token?: string; expires_in: number };
}

async function fetchXeroConnections(accessToken: string) {
  const response = await fetch(xeroConnectionsUrl, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  const payload = await response.json().catch(() => []);
  if (!response.ok) throw new Error(readXeroError(payload, "connection lookup failed"));
  return payload as Array<{ tenantId: string; tenantName: string; tenantType?: string }>;
}

async function fetchXeroOrganisation(session: XeroSession): Promise<XeroOrganisation | undefined> {
  const payload = await fetchXeroApi(session, "https://api.xero.com/api.xro/2.0/Organisation");
  const org = payload?.Organisations?.[0];
  if (!org) return undefined;
  return {
    name: org.Name,
    legalName: org.LegalName,
    countryCode: org.CountryCode,
    baseCurrency: org.BaseCurrency,
    financialYearEndDay: org.FinancialYearEndDay,
    financialYearEndMonth: org.FinancialYearEndMonth,
    organisationType: org.OrganisationType,
  };
}

async function fetchXeroContactsSummary(session: XeroSession): Promise<XeroContactsSummary | undefined> {
  const payload = await fetchXeroApi(session, "https://api.xero.com/api.xro/2.0/Contacts?page=1");
  const contacts = Array.isArray(payload?.Contacts) ? payload.Contacts : [];
  return { count: contacts.length, sampleNames: contacts.slice(0, 3).map((contact: { Name?: string }) => contact.Name).filter(Boolean) };
}

async function fetchXeroApi(session: XeroSession, url: string) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${session.accessToken}`, "xero-tenant-id": session.tenantId, accept: "application/json" } });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(readXeroError(payload, "Xero API request failed"));
  return payload;
}

function readXeroError(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const error = [record.error, record.error_description, record.Message, record.Detail].filter((value) => typeof value === "string" && value.length > 0).join(": ");
    if (error) return error;
  }
  return fallback;
}

function getXeroSession(request: Request) {
  const id = getCookie(request, "xero_session");
  return id ? xeroSessions.get(id) : undefined;
}

function getCookie(request: Request, name: string) {
  const cookie = request.headers.get("cookie");
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return undefined;
}

function serializeCookie(name: string, value: string, options: { maxAge: number; httpOnly?: boolean }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax", `Max-Age=${options.maxAge}`];
  if (options.httpOnly) parts.push("HttpOnly");
  return parts.join("; ");
}

function renderHomePage() {
  return page("Compliance Compass", `
    <main class="home">
      <canvas id="compassCanvas"></canvas>
      <nav><strong>Compliance Compass</strong><span>Xero risk radar</span><a href="/ui">Launch Console</a></nav>
      <section class="hero">
        <p class="kicker">Autonomous compliance navigation</p>
        <h1>Find the risk before it finds the business.</h1>
        <p>Compliance Compass watches Xero signals, filing windows, missing evidence, and bookkeeping drift, then turns them into a weekly action path instead of a quarter-end scramble.</p>
        <div class="actions"><a class="make-compliant" href="/ui">Make me Compliant</a><a href="/xero/auth">Connect Xero</a></div>
      </section>
      <section class="workflow"><article><b>01 Scan</b><span>Read Xero context.</span></article><article><b>02 Prioritise</b><span>Surface risks and deadlines.</span></article><article><b>03 Act</b><span>Create a plain-English plan.</span></article></section>
    </main>
    <script>${canvasScript()}</script>
  `, homeStyles());
}

function renderPage(request: Request) {
  const session = getXeroSession(request);
  return page(agentRole.name, `
    <div class="shell">
      <aside>
        <h1>${escapeHtml(agentRole.name)}</h1>
        <p>${escapeHtml(agentRole.tagline)}</p>
        ${renderXeroConnection(session)}
        <div class="score"><strong>82</strong><span>Compliance health</span></div>
        <h2>Filing Calendar</h2>
        ${agentRole.filingDates.map((item) => `<p class="date"><b>${escapeHtml(item.label)}</b><span>${escapeHtml(item.value)}</span></p>`).join("")}
      </aside>
      <main>
        <header><h2>Risk and deadline console</h2>${agentRole.issueLanes.map((lane) => `<div class="lane ${lane.tone}"><span>${escapeHtml(lane.label)}</span><b>${escapeHtml(lane.value)}</b></div>`).join("")}</header>
        ${session ? renderXeroDemoData(session) : ""}
        <section class="questions">${agentRole.onboardingQuestions.map(renderQuestion).join("")}</section>
        <section id="conversation"><h3>Set up the business profile, then ask for a calendar, evidence list, or action plan.</h3>${agentRole.prompts.map((prompt) => `<button class="prompt" type="button">${escapeHtml(prompt)}</button>`).join("")}</section>
        <form id="composer"><textarea id="message" placeholder="Ask Compliance Compass to build a calendar, check risks, or prepare evidence..." required></textarea><button id="send">Send</button></form>
      </main>
    </div>
    <script>${consoleScript()}</script>
  `, appStyles());
}

function renderQuestion(question: (typeof agentRole.onboardingQuestions)[number]) {
  return `<label>${escapeHtml(question.label)}<select name="${question.id}" data-onboarding>${question.options.map((option) => `<option>${escapeHtml(option)}</option>`).join("")}</select></label>`;
}

function renderXeroConnection(session: XeroSession | undefined) {
  if (!session) return `<section class="connection"><a href="/xero/auth">Link Xero</a><p>Connect accounts, invoices, bills, payroll signals, and evidence trails.</p></section>`;
  const companyName = session.organisation?.name ?? session.tenantName;
  return `<section class="connection connected"><a href="/xero/auth">Refresh Xero</a><a href="/xero/disconnect">Disconnect</a><strong>${escapeHtml(companyName)}</strong><p>Connected to ${escapeHtml(session.tenantType ?? "Xero organisation")}.</p></section>`;
}

function renderXeroDemoData(session: XeroSession) {
  const org = session.organisation;
  const contacts = session.contacts;
  const yearEnd = org?.financialYearEndDay && org.financialYearEndMonth ? `${org.financialYearEndDay}/${org.financialYearEndMonth}` : "Not supplied";
  return `<section><h2>Xero Demo Company</h2><div class="cards">
    ${card("Company", org?.name ?? session.tenantName, org?.legalName ?? "Connected organisation")}
    ${card("Country", org?.countryCode ?? "Not supplied", `Base currency ${org?.baseCurrency ?? "not supplied"}`)}
    ${card("Year End", yearEnd, org?.organisationType ?? "Organisation settings")}
    ${card("Contacts", contacts?.count === undefined ? "Ready" : `${contacts.count} loaded`, contacts?.sampleNames.join(", ") || "No sample contacts returned")}
  </div></section>`;
}

function card(label: string, value: string, detail: string) {
  return `<article class="card"><p>${escapeHtml(label)}</p><strong>${escapeHtml(value)}</strong><span>${escapeHtml(detail)}</span></article>`;
}

function page(title: string, body: string, styles: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${escapeHtml(title)}</title><style>${styles}</style></head><body>${body}</body></html>`;
}

function homeStyles() {
  return `body{margin:0;background:#07110d;color:#eef7f3;font-family:Inter,ui-sans-serif,system-ui,sans-serif}a{color:inherit;text-decoration:none}canvas{position:absolute;inset:0;width:100%;height:100%;opacity:.9}.home{min-height:100vh;position:relative;overflow:hidden}.home:before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(7,17,13,.98),rgba(7,17,13,.7),rgba(7,17,13,.2));z-index:1}nav,.hero,.workflow{position:relative;z-index:2}nav{display:flex;gap:18px;align-items:center;justify-content:space-between;padding:24px 6vw}nav a,.actions a{border-radius:8px;padding:12px 16px;background:#58d99b;color:#062015;font-weight:800}.hero{padding:12vh 6vw 8vh;max-width:980px}.kicker{color:#ffc15a;text-transform:uppercase;font-weight:900;letter-spacing:.16em}h1{font-size:clamp(3rem,8vw,7.8rem);line-height:.9;margin:0}p{font-size:clamp(1.05rem,2vw,1.28rem);line-height:1.55;color:#c9ddd5}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:30px}.actions .make-compliant{min-height:64px;display:inline-flex;align-items:center;background:#f8fffb;color:#061b12;border:2px solid #baf6d8;font-size:clamp(1.05rem,2vw,1.42rem);box-shadow:0 18px 54px rgba(88,217,155,.28)}.workflow{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;background:#f7faf8;color:#17211e;padding:34px 6vw}.workflow article{background:white;border:1px solid #d5dfdb;border-radius:8px;padding:18px;min-height:110px}.workflow span{display:block;color:#50615b;margin-top:10px}@media(max-width:760px){nav{align-items:flex-start}.workflow{grid-template-columns:1fr}}`;
}

function appStyles() {
  return `body{margin:0;background:#f7faf8;color:#17211e;font-family:Inter,ui-sans-serif,system-ui,sans-serif}a,button{font:inherit}.shell{min-height:100vh;display:grid;grid-template-columns:360px 1fr}aside{background:#f0f6f3;border-right:1px solid #d5dfdb;padding:26px}main{padding:24px}h1,h2,h3{margin-top:0}.connection,.score,.date,.card,label,#conversation{display:block;border:1px solid #d5dfdb;border-radius:8px;background:white;padding:12px;margin:10px 0}.connection a,#send,.prompt{border:0;border-radius:8px;background:#1f7a55;color:white;padding:10px 14px;text-decoration:none;font-weight:800;margin-right:8px}.connected{background:#f7fcfa}.score strong{font-size:2rem;color:#1f7a55}.date{display:flex;justify-content:space-between;gap:12px}.date span{color:#61716c}.cards,.questions,header{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px}.questions{grid-template-columns:repeat(5,minmax(130px,1fr))}.card span,.card p{color:#61716c}select,textarea{width:100%;box-sizing:border-box;border:1px solid #bdcac5;border-radius:8px;padding:10px}#composer{display:grid;grid-template-columns:1fr auto;gap:12px;margin-top:20px}textarea{min-height:70px}.lane{background:white;border:1px solid #d5dfdb;border-radius:8px;padding:10px}.lane span{display:block;color:#61716c;font-size:.8rem}@media(max-width:900px){.shell,.cards,.questions,header,#composer{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid #d5dfdb}}`;
}

function canvasScript() {
  return `const c=document.getElementById("compassCanvas"),x=c.getContext("2d");let w,h,r;function s(){r=Math.min(devicePixelRatio||1,2);w=c.clientWidth;h=c.clientHeight;c.width=w*r;c.height=h*r;x.setTransform(r,0,0,r,0,0)}function d(t){t*=.001;x.clearRect(0,0,w,h);const cx=w*.72,cy=h*.48,rad=Math.min(w,h)*.34;x.save();x.translate(cx,cy);x.rotate(t*.08);for(let i=0;i<5;i++){x.beginPath();x.arc(0,0,rad*(.38+i*.15),0,Math.PI*2);x.strokeStyle=i%2?"rgba(255,193,90,.18)":"rgba(88,217,155,.24)";x.stroke()}for(let i=0;i<40;i++){const a=Math.PI*2*i/40;x.beginPath();x.moveTo(Math.cos(a)*rad*.28,Math.sin(a)*rad*.28);x.lineTo(Math.cos(a)*rad*.95,Math.sin(a)*rad*.95);x.strokeStyle=i%5?"rgba(186,246,216,.13)":"rgba(186,246,216,.36)";x.stroke()}x.restore();requestAnimationFrame(d)}s();addEventListener("resize",s);requestAnimationFrame(d);`;
}

function consoleScript() {
  return `const f=document.getElementById("composer"),i=document.getElementById("message"),c=document.getElementById("conversation");for(const p of document.querySelectorAll(".prompt"))p.onclick=()=>{i.value=p.textContent.trim();i.focus()};f.onsubmit=async e=>{e.preventDefault();const m=i.value.trim();if(!m)return;i.value="";const a=document.createElement("p");a.textContent="Compliance Compass is ready to review: "+m;c.append(a)};`;
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
