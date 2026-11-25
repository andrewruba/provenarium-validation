import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

/** Synthetic credentials only. Never use these accounts outside the demonstration. */
export const demoAccounts = {
  operator: {
    username: 'operator',
    password: 'demo-operator-password',
    role: 'operator',
    disabled: false,
  },
  supervisor: {
    username: 'supervisor',
    password: 'demo-supervisor-password',
    role: 'supervisor',
    disabled: false,
  },
  disabled: {
    username: 'disabled',
    password: 'demo-disabled-password',
    role: 'operator',
    disabled: true,
  },
} as const;

type Sample = {
  sampleId: string;
  location: string;
  receiptDate: string;
  mass: number;
  volume: number;
  concentration: number;
  status: 'Received' | 'Approved';
};
type User = (typeof demoAccounts)[keyof typeof demoAccounts];
export type SampleAppOptions = { port?: number; defective?: boolean; dataDir?: string };
const escape = (value: unknown) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const columns = [
  'Sample ID',
  'Storage location',
  'Receipt date',
  'Mass (mg)',
  'Volume (mL)',
  'Concentration (mg/mL)',
  'Status',
];
const cells = (sample: Sample) => [
  sample.sampleId,
  sample.location,
  sample.receiptDate,
  String(sample.mass),
  String(sample.volume),
  sample.concentration.toFixed(3),
  sample.status,
];

export async function startSampleApp(options: SampleAppOptions = {}) {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'provenarium-sample-')));
  await mkdir(dataDir, { recursive: true });
  const recordsPath = join(dataDir, 'samples.json');
  let records: Sample[];
  try {
    records = JSON.parse(await readFile(recordsPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    records = [];
  }
  let defective = options.defective ?? false;
  const sessions = new Map<string, User>();
  const persist = () => writeFile(recordsPath, JSON.stringify(records, null, 2));
  const page = (title: string, content: string, user?: User) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Sample register</title><style>body{font:16px system-ui,sans-serif;color:#182b38;background:#f3f6f8;margin:0}header,main{max-width:1050px;margin:auto;padding:24px}header{border-bottom:1px solid #ccd8df}nav{display:flex;gap:20px;margin-top:15px}a{color:#145d83}h1{font-size:30px}form{max-width:520px}label{display:block;margin:16px 0}input,select,button{font:inherit;padding:10px;border:1px solid #8a9ba6;border-radius:5px}input,select{display:block;width:100%;box-sizing:border-box;margin-top:6px}button{background:#145d83;color:white;cursor:pointer}table{border-collapse:collapse;width:100%;background:white}th,td{border:1px solid #cbd6dc;text-align:left;padding:12px}th{background:#e2ecf1}[role=alert]{padding:16px;background:#fee5e5;color:#851c1c}[role=status]{padding:16px;background:#e0f2e4}pre{white-space:pre-wrap}small{color:#526570}</style></head><body><header><strong>Provenarium synthetic sample register</strong>${user ? `<p data-testid="identity">Signed in as ${escape(user.username)} (${escape(user.role)})</p><nav><a href="/samples">Sample receipt</a><a href="/records">Retained records</a><a href="/attachments">Attachments</a><a href="/export.csv">Download receipt CSV</a></nav><form method="post" action="/logout"><button type="submit">Sign out</button></form>` : ''}</header><main><h1>${escape(title)}</h1>${content}<p><small>Synthetic demonstration data only. This application is not a production laboratory system.</small></p></main></body></html>`;
  const login = (message = '') =>
    page(
      'Sign in',
      `${message ? `<p role="alert">${escape(message)}</p>` : ''}<form method="post" action="/login"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form>`,
    );
  const sampleForm = (user: User, message = '', values: Record<string, string> = {}) =>
    page(
      'Sample receipt',
      `${message ? `<p role="alert">${escape(message)}</p>` : ''}<form method="post" action="/samples" novalidate><label>Sample ID<input name="sampleId" value="${escape(values.sampleId ?? '')}" maxlength="32" required></label><label for="storage-location">Storage location</label><select id="storage-location" name="location"><option${values.location !== 'Chilled' ? ' selected' : ''}>Ambient</option><option${values.location === 'Chilled' ? ' selected' : ''}>Chilled</option></select><label>Receipt date<input name="receiptDate" type="date" value="${escape(values.receiptDate ?? '')}" required></label><label>Mass (mg)<input name="mass" type="number" min="0" step="any" value="${escape(values.mass ?? '')}" required></label><label>Volume (mL)<input name="volume" type="number" min="0.000001" step="any" value="${escape(values.volume ?? '')}" required></label><button type="submit">Save sample</button></form>`,
      user,
    );
  const table = (rows: Sample[]) =>
    `<table aria-label="Receipt records"><thead><tr>${columns.map((c) => `<th scope="col">${escape(c)}</th>`).join('')}</tr></thead><tbody>${rows
      .map(
        (row) =>
          `<tr>${cells(row)
            .map((c) => `<td>${escape(c)}</td>`)
            .join('')}</tr>`,
      )
      .join('')}</tbody></table>`;
  const send = (
    res: ServerResponse,
    status: number,
    body: string | Buffer,
    type = 'text/html; charset=utf-8',
    extra: Record<string, string> = {},
  ) => {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      ...extra,
    });
    res.end(body);
  };
  const redirect = (
    res: ServerResponse,
    location: string,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers });
    res.end();
  };
  async function readBody(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const part = Buffer.from(chunk);
      size += part.length;
      if (size > 128 * 1024) throw new Error('Request body exceeds 128 KiB.');
      chunks.push(part);
    }
    return Buffer.concat(chunks);
  }
  function validate(fields: Record<string, string>): string | undefined {
    if (!fields.sampleId?.trim()) return 'Sample ID is required.';
    if (fields.sampleId.trim().length > 32) return 'Sample ID must be 1 to 32 characters.';
    if (!['Ambient', 'Chilled'].includes(fields.location))
      return 'Storage location must be Ambient or Chilled.';
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(fields.receiptDate ?? '') ||
      Number.isNaN(Date.parse(fields.receiptDate)) ||
      new Date(fields.receiptDate).toISOString().slice(0, 10) !== fields.receiptDate
    )
      return 'Receipt date must be a valid calendar date.';
    if (!fields.mass?.trim() || !Number.isFinite(Number(fields.mass)) || Number(fields.mass) < 0)
      return 'Mass must be a number greater than or equal to zero.';
    if (
      !fields.volume?.trim() ||
      !Number.isFinite(Number(fields.volume)) ||
      Number(fields.volume) <= 0
    )
      return 'Volume must be a number greater than zero.';
    if (!Number.isFinite(Number(fields.mass) / Number(fields.volume)))
      return 'Concentration cannot be represented.';
    if (!defective && records.some((record) => record.sampleId === fields.sampleId.trim()))
      return 'Sample ID already exists. The original record is unchanged.';
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const sessionId = /(?:^|;\s*)sample_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      const user = sessionId ? sessions.get(sessionId) : undefined;
      if (req.method === 'GET' && url.pathname === '/health')
        return send(
          res,
          200,
          JSON.stringify({
            status: 'ok',
            application: 'Synthetic sample register',
            version: defective ? 'defective' : 'good',
          }),
          'application/json',
        );
      if (req.method === 'GET' && url.pathname === '/login') return send(res, 200, login());
      if (req.method === 'POST' && url.pathname === '/login') {
        const fields = Object.fromEntries(
          new URLSearchParams((await readBody(req)).toString('utf8')),
        );
        const account = Object.values(demoAccounts).find(
          (account) =>
            account.username === fields.username &&
            account.password === fields.password &&
            !account.disabled,
        );
        if (!account) return send(res, 401, login('Login denied.'));
        const token = randomUUID();
        sessions.set(token, account);
        return redirect(res, '/samples', {
          'Set-Cookie': `sample_session=${token}; Path=/; HttpOnly; SameSite=Lax`,
        });
      }
      if (req.method === 'POST' && url.pathname === '/logout') {
        if (sessionId) sessions.delete(sessionId);
        return redirect(res, '/login', {
          'Set-Cookie': 'sample_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
        });
      }
      if (!user)
        return url.pathname.startsWith('/api/')
          ? send(res, 401, '{"error":"Authentication required"}', 'application/json')
          : redirect(res, '/login');
      if (req.method === 'GET' && url.pathname === '/') return redirect(res, '/samples');
      if (req.method === 'GET' && url.pathname === '/samples')
        return send(res, 200, sampleForm(user));
      if (req.method === 'POST' && ['/samples', '/api/samples'].includes(url.pathname)) {
        const jsonResponse = url.pathname.startsWith('/api/');
        const raw = (await readBody(req)).toString('utf8');
        const fields = jsonResponse
          ? (JSON.parse(raw) as Record<string, string>)
          : Object.fromEntries(new URLSearchParams(raw));
        const error = validate(fields);
        if (error)
          return send(
            res,
            422,
            jsonResponse ? JSON.stringify({ error }) : sampleForm(user, error, fields),
            jsonResponse ? 'application/json' : 'text/html; charset=utf-8',
          );
        records.push({
          sampleId: fields.sampleId.trim(),
          location: fields.location,
          receiptDate: fields.receiptDate,
          mass: Number(fields.mass),
          volume: Number(fields.volume),
          concentration: Number(fields.mass) / Number(fields.volume),
          status: 'Received',
        });
        await persist();
        return jsonResponse
          ? send(res, 201, JSON.stringify(records.at(-1)), 'application/json')
          : redirect(res, '/records?saved=1');
      }
      if (req.method === 'GET' && url.pathname === '/records')
        return send(
          res,
          200,
          page(
            'Retained records',
            `${url.searchParams.has('saved') ? '<p role="status">Sample saved.</p>' : ''}${table(records)}${user.role === 'supervisor' ? `<h2>Approve a sample</h2><form action="/approve" method="post"><label>Sample ID to approve<input name="sampleId" required></label><button type="submit">Approve sample</button></form>` : ''}`,
            user,
          ),
        );
      if (req.method === 'GET' && url.pathname === '/api/samples')
        return send(res, 200, JSON.stringify({ records }), 'application/json');
      if (req.method === 'POST' && ['/api/approve', '/approve'].includes(url.pathname)) {
        const jsonResponse = url.pathname.startsWith('/api/');
        if (user.role !== 'supervisor')
          return send(
            res,
            403,
            jsonResponse
              ? '{"error":"Supervisor permission required"}'
              : page('Access denied', '<p role="alert">Supervisor permission required.</p>', user),
            jsonResponse ? 'application/json' : 'text/html',
          );
        const raw = (await readBody(req)).toString('utf8');
        const fields = req.headers['content-type']?.includes('application/json')
          ? JSON.parse(raw)
          : Object.fromEntries(new URLSearchParams(raw));
        const record = records.find((record) => record.sampleId === fields.sampleId);
        if (!record) return send(res, 404, '{"error":"Sample not found"}', 'application/json');
        record.status = 'Approved';
        await persist();
        return jsonResponse
          ? send(res, 200, JSON.stringify(record), 'application/json')
          : redirect(res, '/records');
      }
      if (req.method === 'GET' && url.pathname === '/export.csv') {
        const rows = [...records].sort(
          (a, b) =>
            a.receiptDate.localeCompare(b.receiptDate) || a.sampleId.localeCompare(b.sampleId),
        );
        const quote = (value: string) =>
          /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
        const csv =
          [columns, ...rows.map(cells)].map((row) => row.map(quote).join(',')).join('\r\n') +
          '\r\n';
        return send(res, 200, csv, 'text/csv; charset=utf-8', {
          'Content-Disposition': 'attachment; filename="receipt-register.csv"',
        });
      }
      if (req.method === 'GET' && url.pathname === '/attachments')
        return send(
          res,
          200,
          page(
            'Attachments',
            '<form method="post" action="/attachments" enctype="multipart/form-data"><label>Text attachment<input type="file" name="attachment" accept=".txt"></label><button type="submit">Upload attachment</button></form>',
            user,
          ),
        );
      if (req.method === 'POST' && url.pathname === '/attachments') {
        const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(req.headers['content-type'] ?? '');
        const content = (await readBody(req)).toString('utf8');
        if (!boundary)
          return send(
            res,
            400,
            page('Attachment rejected', '<p role="alert">Multipart attachment required.</p>', user),
          );
        const part = content
          .split(`--${boundary[1] ?? boundary[2]}`)
          .find((part) => /name="attachment"; filename="/.test(part));
        const filename = part && /filename="([^"\r\n]+)"/.exec(part)?.[1];
        const text = part?.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
        if (
          !filename ||
          !/^[A-Za-z0-9_.-]+\.txt$/.test(filename) ||
          text === undefined ||
          Buffer.byteLength(text) > 100 * 1024
        )
          return send(
            res,
            422,
            page(
              'Attachment rejected',
              '<p role="alert">A plain-text .txt attachment of at most 100 KiB is required.</p>',
              user,
            ),
          );
        await mkdir(join(dataDir, 'attachments'), { recursive: true });
        await writeFile(join(dataDir, 'attachments', filename), text);
        return send(
          res,
          200,
          page(
            'Attachment retained',
            `<p role="status">Attachment received: ${escape(filename)}</p><pre data-testid="attachment-content">${escape(text)}</pre>`,
            user,
          ),
        );
      }
      send(res, 404, page('Not found', '<p>The requested page does not exist.</p>', user));
    } catch {
      send(
        res,
        400,
        page('Request rejected', '<p role="alert">The request could not be processed.</p>'),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4173, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not determine sample application address.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    dataDir,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
    setDefective: (value: boolean) => {
      defective = value;
    },
    resetRecords: async () => {
      records = [];
      await persist();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const app = await startSampleApp({
    port: Number(value('--port') ?? 4173),
    defective: args.includes('--defective'),
    dataDir: value('--data-dir'),
  });
  process.stdout.write(
    `Synthetic sample register: ${app.url}\nVariant: ${args.includes('--defective') ? 'deliberately defective' : 'good'}\nData: ${app.dataDir}\n`,
  );
  const stop = () => {
    void app.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
