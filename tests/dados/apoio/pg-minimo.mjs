// Cliente mínimo do protocolo PostgreSQL v3, SÓ PARA TESTES (autenticação trust em container local).
// Imita a interface usada de `pg`: pool.query(text, values), pool.connect() → client.query/release, pool.end().
// Tipos convertidos como o `pg`: bool, int2/int4, bytea → Buffer, json/jsonb, timestamptz → Date.
import net from 'node:net';

function cstr(s) {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
}
function msg(type, body) {
  const len = Buffer.alloc(4);
  len.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type), len, body]);
}
function int16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; }
function int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }

function serialize(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `\\x${v.toString('hex')}`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function parseValue(oid, s) {
  switch (oid) {
    case 16: return s === 't';
    case 21: case 23: case 26: case 700: case 701: return Number(s);
    case 17: return Buffer.from(s.slice(2), 'hex');
    case 114: case 3802: return JSON.parse(s);
    case 1114: case 1184: {
      let t = s.replace(' ', 'T');
      if (/[+-]\d\d$/.test(t)) t += ':00';
      return new Date(oid === 1114 ? `${t}Z` : t);
    }
    default: return s;
  }
}

class Connection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.handler = null;
    this.chain = Promise.resolve();
    socket.on('data', (d) => { this.buffer = Buffer.concat([this.buffer, d]); this.drain(); });
    socket.on('error', (e) => this.handler?.fail(e));
    socket.on('close', () => this.handler?.fail(Object.assign(new Error('conexão encerrada'), { code: '08006' })));
  }

  drain() {
    while (this.buffer.length >= 5) {
      const len = this.buffer.readInt32BE(1);
      if (this.buffer.length < len + 1) return;
      const type = String.fromCharCode(this.buffer[0]);
      const body = this.buffer.subarray(5, len + 1);
      this.buffer = this.buffer.subarray(len + 1);
      this.handler?.message(type, body);
    }
  }

  exchange(payload) {
    return new Promise((resolve, reject) => {
      const result = { rows: [], rowCount: 0, fields: [] };
      let error = null;
      this.handler = {
        fail: (e) => { this.handler = null; reject(e); },
        message: (type, body) => {
          if (type === 'R') {
            const code = body.readInt32BE(0);
            if (code !== 0) error = new Error(`autenticação ${code} não suportada pelo cliente de teste`);
          } else if (type === 'T') {
            const n = body.readInt16BE(0);
            let o = 2;
            result.fields = [];
            for (let i = 0; i < n; i++) {
              const end = body.indexOf(0, o);
              const name = body.toString('utf8', o, end);
              o = end + 1;
              const oid = body.readInt32BE(o + 6);
              o += 18;
              result.fields.push({ name, oid });
            }
            result.rows = [];
          } else if (type === 'D') {
            const n = body.readInt16BE(0);
            let o = 2;
            const row = {};
            for (let i = 0; i < n; i++) {
              const len = body.readInt32BE(o);
              o += 4;
              const f = result.fields[i];
              if (len === -1) { row[f.name] = null; continue; }
              row[f.name] = parseValue(f.oid, body.toString('utf8', o, o + len));
              o += len;
            }
            result.rows.push(row);
          } else if (type === 'C') {
            const tag = body.toString('utf8', 0, body.length - 1);
            const m = /(\d+)$/.exec(tag);
            result.rowCount = m ? Number(m[1]) : 0;
            result.command = tag.split(' ')[0];
          } else if (type === 'E') {
            const fields = {};
            let o = 0;
            while (body[o] !== 0) {
              const k = String.fromCharCode(body[o]);
              const end = body.indexOf(0, o + 1);
              fields[k] = body.toString('utf8', o + 1, end);
              o = end + 1;
            }
            error = Object.assign(new Error(fields.M), { code: fields.C, constraint: fields.n, detail: fields.D });
          } else if (type === 'Z') {
            this.handler = null;
            if (error) reject(error); else resolve(result);
          }
        },
      };
      this.socket.write(payload);
    });
  }

  query(text, values) {
    const run = () => {
      if (!values || values.length === 0) return this.exchange(msg('Q', cstr(text)));
      const params = values.map(serialize);
      const bind = [cstr(''), cstr(''), int16(0), int16(params.length)];
      for (const p of params) {
        if (p === null) bind.push(int32(-1));
        else { const b = Buffer.from(p, 'utf8'); bind.push(int32(b.length), b); }
      }
      bind.push(int16(0));
      return this.exchange(Buffer.concat([
        msg('P', Buffer.concat([cstr(''), cstr(text), int16(0)])),
        msg('B', Buffer.concat(bind)),
        msg('D', Buffer.concat([Buffer.from('P'), cstr('')])),
        msg('E', Buffer.concat([cstr(''), int32(0)])),
        msg('S', Buffer.alloc(0)),
      ]));
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  close() {
    try { this.socket.write(msg('X', Buffer.alloc(0))); } catch { /* já fechado */ }
    this.socket.end();
  }
}

export async function connect({ host = '127.0.0.1', port, user = 'postgres', database = 'postgres' }) {
  const socket = await new Promise((resolve, reject) => {
    const s = net.connect({ host, port }, () => resolve(s));
    s.once('error', reject);
  });
  const conn = new Connection(socket);
  const startup = Buffer.concat([int32(196608), cstr('user'), cstr(user), cstr('database'), cstr(database),
    cstr('TimeZone'), cstr('UTC'), Buffer.from([0])]);
  const len = int32(startup.length + 4);
  await conn.exchange(Buffer.concat([len, startup]));
  return conn;
}

export class Pool {
  constructor(options) {
    this.options = options;
    this.idle = [];
    this.all = new Set();
  }

  async connect() {
    const conn = this.idle.pop() ?? await connect(this.options);
    this.all.add(conn);
    return {
      query: (t, v) => conn.query(t, v),
      release: (destroy) => {
        if (destroy) { this.all.delete(conn); conn.close(); } else this.idle.push(conn);
      },
    };
  }

  async query(text, values) {
    const client = await this.connect();
    try {
      return await client.query(text, values);
    } finally {
      client.release();
    }
  }

  async end() {
    for (const c of this.all) c.close();
    this.all.clear();
    this.idle = [];
  }
}
