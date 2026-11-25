import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export type Defect = 'concentration-units' | 'zero-volume' | 'duplicate-id' | 'csv-units';
export const allDefects: Defect[] = [
  'concentration-units',
  'zero-volume',
  'duplicate-id',
  'csv-units',
];
export type DilutionPlan = {
  sampleId: string;
  stockMgMl: number;
  targetMgMl: number;
  finalMl: number;
  stockMl: number;
  diluentMl: number;
};
export type DilutionAppOptions = {
  port?: number;
  host?: string;
  defects?: Defect[];
  commit?: string;
};
type Fields = Record<string, string>;
type Workspace = {
  plans: Map<string, DilutionPlan>;
  generation: string;
  lastUsed: number;
};
const WORKSPACE_TTL_MS = 60 * 60 * 1000;
const MAX_WORKSPACES = 100;
const MAX_RECORDS = 500;

const columns = [
  'Sample ID',
  'Stock (mg/mL)',
  'Target (mg/mL)',
  'Final volume (mL)',
  'Stock volume (mL)',
  'Diluent volume (mL)',
];
const escape = (value: unknown) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const decimal = (value: number) => value.toFixed(3);
const cells = (plan: DilutionPlan, exportStockFactor = 1) => [
  plan.sampleId,
  decimal(plan.stockMgMl),
  decimal(plan.targetMgMl),
  decimal(plan.finalMl),
  decimal(plan.stockMl * exportStockFactor),
  decimal(plan.diluentMl),
];

const styles = `
  :root{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172d3b;background:#edf2f5;font-synthesis:none}
  *{box-sizing:border-box}body{margin:0;font-size:16px;line-height:1.5}a{color:#006f68;text-underline-offset:4px}a:hover{color:#004e49}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #168cbd;outline-offset:3px}
  .topbar{background:#142e3d;color:#fff}.topbar-inner{max-width:1184px;margin:auto;padding:23px 32px;display:flex;align-items:center;justify-content:space-between;gap:28px}.brand{display:flex;align-items:center;gap:13px;font-weight:650;letter-spacing:-.03em;font-size:23px;color:inherit;text-decoration:none}.brand-mark{width:34px;height:34px;border:1px solid #7ca4b2;border-radius:8px;display:grid;place-items:center;color:#9be0d1;font-size:18px;letter-spacing:0}
  nav{display:flex;align-items:center;gap:25px}nav a{font-size:14px;color:#d9e7ee;text-decoration:none}nav a:hover,nav a[aria-current=page]{color:#fff;text-decoration:underline}nav .download{border:1px solid #6b8b9b;padding:8px 14px;border-radius:6px}
  main{max-width:1184px;margin:auto;padding:38px 32px 48px}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.14em;font-weight:700;color:#53717f;margin:0 0 9px}h1{font-size:34px;line-height:1.2;letter-spacing:-.045em;margin:0 0 11px;font-weight:650}.intro{margin:0;color:#506674;max-width:660px}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;align-items:start;margin-top:28px}
  .card{background:#fff;border:1px solid #d4e0e7;border-radius:12px;box-shadow:0 3px 12px #17364705}.card-head{padding:22px 26px 18px;border-bottom:1px solid #e4ebef}.card-head h2{font-size:18px;letter-spacing:-.02em;margin:0 0 4px}.card-head p{font-size:14px;color:#607481;margin:0}.form-body{padding:24px 26px}.field{margin-bottom:22px}.field:last-child{margin-bottom:0}label{display:block;font-size:14px;font-weight:600;margin-bottom:7px}.hint{color:#637784;font-size:13px;margin:6px 0 0}.pair{display:grid;grid-template-columns:minmax(0,1fr) 136px;gap:13px}.concentrations{display:grid;grid-template-columns:1fr 1fr;gap:20px}.concentrations .pair{grid-template-columns:minmax(0,1fr) 109px}
  input,select,button{font:inherit}input,select{width:100%;padding:11px 12px;border:1px solid #aabcc8;border-radius:6px;background:#fff;color:#172d3b;height:47px}input::placeholder{color:#718592}select{appearance:none;padding-right:28px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%23446273' stroke-width='1.6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center}
  .form-footer{background:#f8fafb;border-top:1px solid #e4ebef;padding:20px 26px;border-radius:0 0 12px 12px;display:flex;align-items:center;justify-content:space-between;gap:20px}.form-footer p{color:#637784;font-size:13px;margin:0;max-width:225px}button{border:0;border-radius:6px;padding:12px 20px;background:#00776d;color:#fff;font-weight:600;font-size:15px;cursor:pointer;white-space:nowrap}button:hover{background:#005d56}
  aside{display:grid;gap:18px}.reference{padding:22px}.reference h2{font-size:15px;margin:0 0 15px}.formula{border:1px solid #c9e4df;background:#f0f8f6;color:#145e57;font-family:Georgia,serif;text-align:center;font-size:27px;padding:16px 8px;border-radius:7px;margin:0 0 16px}.reference dl{display:grid;grid-template-columns:34px 1fr;gap:9px 8px;margin:0;font-size:14px}.reference dt{font-weight:600;color:#2f5e69}.reference dd{margin:0;color:#536b79}.reference p{font-size:14px;color:#536b79;margin:0 0 12px}.reference p:last-child{margin-bottom:0}.reference .note{padding-top:14px;margin-top:16px;border-top:1px solid #e1e9ed;font-size:13px}
  .alert{padding:15px 18px;border:1px solid #e7b9ae;background:#fff3ef;color:#903b24;border-radius:8px;margin:23px 0 0}.results{margin-top:26px;border:1px solid #a7cec5;background:#f2faf7;border-radius:10px;padding:22px 25px}.results h2{font-size:18px;margin:0 0 4px;color:#155b50}.results .saved-label{font-size:14px;color:#436e65;margin:0}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;margin-top:20px}.metric-label{font-size:13px;color:#4b6b64;margin:0 0 6px}.metric-number{font-size:29px;font-weight:600;letter-spacing:-.04em;color:#173e36;font-variant-numeric:tabular-nums}.unit{font-size:13px;letter-spacing:0;font-weight:400;color:#4b6b64;margin-left:5px}
  .table-card{margin-top:28px;overflow:hidden}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px;text-align:right;font-variant-numeric:tabular-nums}caption{text-align:left;padding:19px 24px;font-weight:600;font-size:16px}th,td{padding:15px 20px;border-bottom:1px solid #e4ebef;white-space:nowrap}th{background:#f4f7f9;font-size:13px;font-weight:600;color:#465f6d}th:first-child,td:first-child{text-align:left}tr:last-child td{border-bottom:0}td:first-child{font-weight:600}tbody tr:hover{background:#f7fafb}.empty{padding:42px 24px;text-align:center;color:#637784}.empty strong{display:block;color:#334f60;margin-bottom:6px}.record-note{padding:15px 24px;border-top:1px solid #e4ebef;font-size:13px;color:#647b88;background:#f8fafb;margin:0}
  footer{max-width:1184px;margin:auto;padding:0 32px 28px;color:#627985;font-size:12px;display:flex;justify-content:space-between;gap:20px}footer span:last-child{color:#7b8d98}
  @media(max-width:1020px){.workspace{grid-template-columns:minmax(0,1fr) 260px}.concentrations{grid-template-columns:1fr;gap:0}.concentrations .pair{grid-template-columns:minmax(0,1fr) 136px}}
  @media(max-width:760px){.topbar-inner{padding:19px 20px;align-items:flex-start;flex-direction:column;gap:17px}nav{flex-wrap:wrap;gap:18px}nav a{font-size:14px}main{padding:28px 20px 36px}h1{font-size:29px}.workspace{grid-template-columns:1fr;gap:20px}aside{grid-template-columns:1fr 1fr;gap:15px}.reference{padding:18px}.form-body,.card-head{padding:21px}.form-footer{padding:19px 21px;align-items:flex-start;flex-direction:column;gap:13px}.form-footer p{max-width:none}.form-footer button{width:100%}.metrics{gap:15px}.metric-number{font-size:24px}.results{padding:20px}footer{padding:0 20px 25px;flex-direction:column;gap:3px}}
  @media(max-width:440px){aside{grid-template-columns:1fr}.metrics{grid-template-columns:1fr;gap:15px}.metric{display:flex;align-items:baseline;justify-content:space-between;gap:10px}.metric-label{margin:0}.pair,.concentrations .pair{grid-template-columns:minmax(0,1fr) 112px}nav{gap:14px}nav .download{padding:6px 10px}}
`;

function page(title: string, content: string, records = false, prefix = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Dilution Bench</title><style>${styles}</style></head><body>
  <header class="topbar"><div class="topbar-inner"><a class="brand" href="${prefix}/" aria-label="Dilution Bench home"><span class="brand-mark" aria-hidden="true">∴</span>Dilution Bench</a><nav aria-label="Main navigation"><a href="${prefix}/"${records ? '' : ' aria-current="page"'}>Prepare dilution</a><a href="${prefix}/records"${records ? ' aria-current="page"' : ''}>Saved preparations</a><a class="download" href="${prefix}/export.csv">Download CSV</a></nav></div></header>
  <main>${content}${prefix ? `<section class="card reference" style="margin-top:24px"><h2>Workspace ${escape(prefix.slice(3))}</h2><p>Only synthetic data belongs here. Anyone with this workspace URL can view or clear its preparations. Clear discovery data before starting a validation run.</p><form method="post" action="${prefix}/reset"><button type="submit">Clear preparations</button></form></section>` : ''}</main><footer><span>Synthetic validation sandbox · ${prefix ? 'Workspace clears after one hour idle or a server restart.' : 'Session data resets when the server restarts.'}</span><span>Single-step dilution · C₁V₁ = C₂V₂</span></footer></body></html>`;
}

function form(fields: Fields = {}, error = '', result?: DilutionPlan, prefix = '') {
  const input = (name: string, label: string, placeholder: string, numeric = true) =>
    `<label for="${name}">${label}</label><input id="${name}" name="${name}" type="${numeric ? 'number' : 'text'}"${numeric ? ' step="any"' : ' autocomplete="off"'} value="${escape(fields[name] ?? '')}" placeholder="${placeholder}">`;
  const select = (name: string, label: string, choices: string[]) =>
    `<label for="${name}">${label}</label><select id="${name}" name="${name}">${choices.map((choice) => `<option value="${choice}"${(fields[name] ?? choices[0]) === choice ? ' selected' : ''}>${choice === 'ug/mL' ? 'µg/mL' : choice === 'uL' ? 'µL' : choice}</option>`).join('')}</select>`;
  const metric = (label: string, testId: string, value: number, unit: string) =>
    `<div class="metric"><p class="metric-label">${label}</p><div class="metric-number"><span data-testid="${testId}">${decimal(value)}</span><span class="unit">${unit}</span></div></div>`;
  return page(
    'Prepare a dilution',
    `<p class="eyebrow">Laboratory calculations</p><h1>Prepare a dilution</h1><p class="intro">Calculate the stock and diluent volumes for a single preparation. Choose your units, then save the result to your session.</p>
    ${error ? `<p class="alert" role="alert">${escape(error)}</p>` : ''}
    ${result ? `<section class="results" aria-label="Calculated preparation"><h2>Preparation saved</h2><p class="saved-label" role="status">Sample <strong data-testid="result-sample-id">${escape(result.sampleId)}</strong> is in your saved preparations.</p><div class="metrics">${metric('Stock to transfer', 'result-stock-volume', result.stockMl, 'mL')}${metric('Diluent to add', 'result-diluent-volume', result.diluentMl, 'mL')}${metric('Target concentration', 'result-target-concentration', result.targetMgMl, 'mg/mL')}</div></section>` : ''}
    <div class="workspace"><section class="card" aria-label="Preparation inputs"><div class="card-head"><h2>Preparation details</h2><p>All fields are required. Results are displayed to three decimal places.</p></div><form method="post" action="${prefix}/plans" novalidate><div class="form-body"><div class="field">${input('sampleId', 'Sample ID', 'e.g. BUFFER-001', false)}<p class="hint">A unique ID of up to 32 letters, numbers, periods, hyphens, or underscores.</p></div><div class="concentrations"><div class="field"><div class="pair"><div>${input('stockConcentration', 'Stock concentration', '10')}</div><div>${select('stockUnit', 'Stock unit', ['mg/mL', 'ug/mL'])}</div></div></div><div class="field"><div class="pair"><div>${input('targetConcentration', 'Target concentration', '1')}</div><div>${select('targetUnit', 'Target unit', ['mg/mL', 'ug/mL'])}</div></div></div></div><div class="field"><div class="pair"><div>${input('finalVolume', 'Final volume', '10')}</div><div>${select('volumeUnit', 'Volume unit', ['mL', 'uL'])}</div></div><p class="hint">The total volume after adding stock and diluent.</p></div></div><div class="form-footer"><p>Saved results use mg/mL and mL, regardless of the input units.</p><button type="submit">Calculate and save</button></div></form></section>
    <aside aria-label="Calculation reference"><section class="card reference"><h2>The dilution equation</h2><div class="formula">C₁V₁ = C₂V₂</div><dl><dt>C₁</dt><dd>Stock concentration</dd><dt>V₁</dt><dd>Stock volume to transfer</dd><dt>C₂</dt><dd>Target concentration</dd><dt>V₂</dt><dd>Final preparation volume</dd></dl><p class="note">Diluent volume = final volume − stock volume.</p></section><section class="card reference"><h2>Before you calculate</h2><p>The target concentration must be no greater than the stock concentration.</p><p>Concentrations and final volume must be positive.</p><p class="note">1 mg/mL = 1,000 µg/mL<br>1 mL = 1,000 µL</p></section></aside></div>`,
    false,
    prefix,
  );
}

function recordsPage(plans: DilutionPlan[], prefix = '') {
  return page(
    'Saved preparations',
    `<p class="eyebrow">Preparation register</p><h1>Saved preparations</h1><p class="intro">Review your session’s dilution calculations. Numeric values use mg/mL and mL and are shown to three decimal places.</p><section class="card table-card"><div class="table-scroll"><table aria-label="Dilution records"><caption>${plans.length} saved preparation${plans.length === 1 ? '' : 's'}</caption><thead><tr>${columns.map((label) => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${plans
      .map(
        (plan) =>
          `<tr data-testid="record-${escape(plan.sampleId)}">${cells(plan)
            .map((cell) => `<td>${escape(cell)}</td>`)
            .join('')}</tr>`,
      )
      .join(
        '',
      )}</tbody></table></div>${plans.length ? '' : '<div class="empty"><strong>No preparations saved yet</strong>Create a dilution to add your first result to the register.</div>'}<p class="record-note">Sorted by Sample ID. Download CSV to keep a copy of these session records.</p></section>`,
    true,
    prefix,
  );
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readFields(req: IncomingMessage): Promise<Fields> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const part = Buffer.from(chunk);
    length += part.length;
    if (length > 16 * 1024) throw new RequestError(413, 'Request body exceeds 16 KiB.');
    chunks.push(part);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
  let parsed: unknown;
  if (type === 'application/json') {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RequestError(400, 'Request body must contain valid JSON.');
    }
  } else if (type === 'application/x-www-form-urlencoded') {
    parsed = Object.fromEntries(new URLSearchParams(text));
  } else {
    throw new RequestError(415, 'Use JSON or URL-encoded form fields.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new RequestError(400, 'Request fields must be an object.');
  const fields: Fields = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' && typeof value !== 'number')
      throw new RequestError(400, 'Field values must be strings or numbers.');
    fields[key] = String(value);
  }
  return fields;
}

function validateDefects(defects: Defect[]) {
  if (!Array.isArray(defects) || defects.some((defect) => !allDefects.includes(defect)))
    throw new Error(`Unknown defect. Choose from: ${allDefects.join(', ')}.`);
  return new Set(defects);
}

export async function startDilutionApp(options: DilutionAppOptions = {}) {
  let defects = validateDefects(options.defects ?? allDefects);
  const instance = randomUUID();
  const commit = options.commit ?? process.env.RENDER_GIT_COMMIT ?? process.env.APP_COMMIT;
  const createWorkspace = (): Workspace => ({
    plans: new Map(),
    generation: randomUUID(),
    lastUsed: Date.now(),
  });
  const localWorkspace = createWorkspace();
  const workspaces = new Map<string, Workspace>();
  const workspaceFor = (id: string): Workspace => {
    const now = Date.now();
    for (const [key, workspace] of workspaces)
      if (now - workspace.lastUsed >= WORKSPACE_TTL_MS) workspaces.delete(key);
    let workspace = workspaces.get(id);
    if (!workspace) {
      if (workspaces.size >= MAX_WORKSPACES)
        throw new RequestError(
          503,
          'Workspace capacity reached. Try again after an idle workspace expires.',
        );
      workspace = createWorkspace();
      workspaces.set(id, workspace);
    }
    workspace.lastUsed = now;
    return workspace;
  };
  const sortedPlans = (plans: Map<string, DilutionPlan>) =>
    [...plans.values()].sort((a, b) =>
      a.sampleId < b.sampleId ? -1 : a.sampleId > b.sampleId ? 1 : 0,
    );

  function calculate(fields: Fields, plans: Map<string, DilutionPlan>): DilutionPlan {
    const sampleId = fields.sampleId?.trim() ?? '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(sampleId))
      throw new RequestError(
        422,
        'Sample ID must be 1 to 32 letters, numbers, periods, hyphens, or underscores, starting with a letter or number.',
      );
    const numeric = (name: string, label: string) => {
      const value = Number(fields[name]);
      if (!fields[name]?.trim() || !Number.isFinite(value))
        throw new RequestError(422, `${label} must be a finite number.`);
      return value;
    };
    const concentration = (value: number, unit: string, label: string) => {
      if (!['mg/mL', 'ug/mL'].includes(unit))
        throw new RequestError(422, `${label} unit must be mg/mL or ug/mL.`);
      // Seeded defect: a misplaced decimal in the microgram conversion makes cross-unit results tenfold wrong.
      const result =
        unit === 'ug/mL' ? value / (defects.has('concentration-units') ? 100 : 1000) : value;
      if (result <= 0 || result > 1e9)
        throw new RequestError(
          422,
          `${label} must be greater than zero and no more than 1,000,000,000 mg/mL.`,
        );
      return result;
    };
    const stockMgMl = concentration(
      numeric('stockConcentration', 'Stock concentration'),
      fields.stockUnit,
      'Stock concentration',
    );
    const targetMgMl = concentration(
      numeric('targetConcentration', 'Target concentration'),
      fields.targetUnit,
      'Target concentration',
    );
    if (targetMgMl > stockMgMl)
      throw new RequestError(422, 'Target concentration must not exceed stock concentration.');
    if (!['mL', 'uL'].includes(fields.volumeUnit))
      throw new RequestError(422, 'Volume unit must be mL or uL.');
    const finalMl =
      numeric('finalVolume', 'Final volume') / (fields.volumeUnit === 'uL' ? 1000 : 1);
    // Seeded defect: the inclusive zero boundary admits an impossible preparation.
    if (defects.has('zero-volume') ? finalMl < 0 : finalMl <= 0)
      throw new RequestError(422, 'Final volume must be greater than zero.');
    if (finalMl > 1e9)
      throw new RequestError(422, 'Final volume must be no more than 1,000,000,000 mL.');
    if (plans.has(sampleId) && !defects.has('duplicate-id'))
      throw new RequestError(409, 'Sample ID already exists. The original record is unchanged.');
    let stockMl = (targetMgMl / stockMgMl) * finalMl;
    // Retry the alternate ordering when a very small ratio underflows before
    // multiplication. The input bounds keep this intermediate product finite.
    if (stockMl === 0 && finalMl > 0) stockMl = (targetMgMl * finalMl) / stockMgMl;
    const diluentMl = finalMl - stockMl;
    if (!Number.isFinite(stockMl) || !Number.isFinite(diluentMl) || (finalMl > 0 && stockMl <= 0))
      throw new RequestError(422, 'The calculated volumes cannot be represented.');
    return { sampleId, stockMgMl, targetMgMl, finalMl, stockMl, diluentMl };
  }

  const send = (
    res: ServerResponse,
    status: number,
    body: string,
    type = 'text/html; charset=utf-8',
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      ...headers,
    });
    res.end(body);
  };
  const server = createServer(async (req, res) => {
    // Keep the raw path: URL normalization of /w/id/../../api/plans would
    // otherwise escape an isolated workspace into the shared local register.
    const pathname = (req.url ?? '/').split('?')[0];
    let route = pathname;
    let prefix = '';
    let workspace = localWorkspace;
    let json = pathname.includes('/api/') || pathname.endsWith('/health');
    let fields: Fields = {};
    try {
      if (pathname === '/w' || pathname.startsWith('/w/')) {
        const match = /^\/w\/([A-Za-z0-9_-]{8,80})(\/.*)?$/.exec(pathname);
        if (!match) throw new RequestError(404, 'Workspace URL is invalid.');
        prefix = `/w/${match[1]}`;
        route = match[2] ?? '/';
        json = route.startsWith('/api/') || route === '/health';
        if (
          !['/', '/plans', '/records', '/api/plans', '/export.csv', '/health', '/reset'].includes(
            route,
          )
        )
          throw new RequestError(404, 'Not found.');
        workspace = workspaceFor(match[1]);
        res.setHeader('X-Dilution-Workspace', match[1]);
        res.setHeader('X-Dilution-Instance', instance);
        res.setHeader('X-Dilution-Generation', workspace.generation);
        if (!match[2]) {
          res.writeHead(308, { Location: `${prefix}/`, 'Cache-Control': 'no-store' });
          return res.end();
        }
      }
      const plans = workspace.plans;
      if (req.method === 'GET' && route === '/health')
        return send(
          res,
          200,
          JSON.stringify({
            status: 'ok',
            application: 'Dilution Bench',
            mode: defects.size ? 'faulty' : 'correct',
            ...(commit ? { commit } : {}),
          }),
          'application/json',
        );
      if (req.method === 'POST' && prefix && route === '/reset') {
        workspace.plans.clear();
        workspace.generation = randomUUID();
        res.setHeader('X-Dilution-Generation', workspace.generation);
        res.writeHead(303, { Location: `${prefix}/`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (req.method === 'GET' && route === '/')
        return send(res, 200, form({}, '', undefined, prefix));
      if (req.method === 'GET' && route === '/records')
        return send(res, 200, recordsPage(sortedPlans(plans), prefix));
      if (req.method === 'GET' && route === '/api/plans')
        return send(res, 200, JSON.stringify({ plans: sortedPlans(plans) }), 'application/json');
      if (req.method === 'POST' && ['/plans', '/api/plans'].includes(route)) {
        fields = await readFields(req);
        const plan = calculate(fields, plans);
        if (!plans.has(plan.sampleId) && plans.size >= MAX_RECORDS)
          throw new RequestError(
            503,
            'Preparation capacity reached. Clear this workspace before adding more.',
          );
        // Seeded defect: skipping duplicate rejection makes Map.set silently replace the original preparation.
        plans.set(plan.sampleId, plan);
        return send(
          res,
          201,
          json ? JSON.stringify({ plan }) : form(fields, '', plan, prefix),
          json ? 'application/json' : 'text/html; charset=utf-8',
        );
      }
      if (req.method === 'GET' && route === '/export.csv') {
        // Seeded defect: converting stock volume to microliters without changing the mL column header.
        const factor = defects.has('csv-units') ? 1000 : 1;
        const csv =
          [columns, ...sortedPlans(plans).map((plan) => cells(plan, factor))]
            .map((row) => row.join(','))
            .join('\r\n') + '\r\n';
        return send(res, 200, csv, 'text/csv; charset=utf-8', {
          'Content-Disposition': 'attachment; filename="dilution-preparations.csv"',
        });
      }
      return send(
        res,
        404,
        json
          ? JSON.stringify({ error: 'Not found.' })
          : page('Not found', '<h1>Not found</h1><p>This page does not exist.</p>', false, prefix),
        json ? 'application/json' : 'text/html; charset=utf-8',
      );
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500;
      const message =
        error instanceof RequestError ? error.message : 'The request could not be processed.';
      send(
        res,
        status,
        json ? JSON.stringify({ error: message }) : form(fields, message, undefined, prefix),
        json ? 'application/json' : 'text/html; charset=utf-8',
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4174, options.host ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not determine application address.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
    resetRecords: async () => {
      localWorkspace.plans.clear();
      localWorkspace.generation = randomUUID();
      workspaces.clear();
    },
    setDefects: (value: Defect[]) => {
      defects = validateDefects(value);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const settings = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      if (flag === '--help') {
        process.stdout.write(
          'Dilution Bench\nUsage: --mode faulty|correct --host 127.0.0.1 --port 4174 --defects concentration-units,zero-volume,duplicate-id,csv-units\nHOST, PORT and DILUTION_MODE supply defaults; CLI flags override them. Defaults to faulty mode with all four deliberate defects. Use --mode correct for the reference app.\n',
        );
        process.exit(0);
      }
      if (
        !['--mode', '--host', '--port', '--defects'].includes(flag) ||
        args[index + 1] === undefined ||
        settings.has(flag)
      )
        throw new Error(`Invalid or repeated option: ${flag}. Use --help for usage.`);
      settings.set(flag, args[index + 1]);
    }
    const mode = settings.get('--mode') ?? process.env.DILUTION_MODE ?? 'faulty';
    if (!['faulty', 'correct'].includes(mode)) throw new Error('Mode must be faulty or correct.');
    const port = Number(settings.get('--port') ?? process.env.PORT ?? 4174);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error('Port must be an integer from 0 to 65535.');
    const defects = settings.has('--defects')
      ? (settings.get('--defects')!.split(',').filter(Boolean) as Defect[])
      : mode === 'faulty'
        ? allDefects
        : [];
    const host = settings.get('--host') ?? process.env.HOST ?? '127.0.0.1';
    const app = await startDilutionApp({ port, host, defects });
    process.stdout.write(
      `Dilution Bench: ${app.url}\nMode: ${defects.length ? 'faulty' : 'correct'}\nActive defects: ${defects.join(', ') || 'none'}\nSynthetic data stays in memory and resets on restart.\n`,
    );
    const stop = () => {
      void app.close().then(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
