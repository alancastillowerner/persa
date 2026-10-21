// Simulador mínimo de Cloudflare D1 sobre node:sqlite, para probar el Worker sin conexión.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

class Stmt {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...args) {
    return new Stmt(this.db, this.sql, args.map(norm));
  }
  isQuery() {
    return /^\s*(select|with|pragma)/i.test(this.sql) || /\breturning\b/i.test(this.sql);
  }
  _all() {
    return this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r }));
  }
  _run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first(col) {
    const rows = this._all();
    if (!rows.length) return null;
    return col ? rows[0][col] : rows[0];
  }
  async all() {
    return { results: this._all(), meta: { changes: 0 } };
  }
  async run() {
    return this._run();
  }
  exec() {
    return this.isQuery() ? { results: this._all(), meta: { changes: 0 } } : this._run();
  }
}

export function createD1(schemaPath, file = ':memory:') {
  const db = new DatabaseSync(file);
  if (schemaPath) db.exec(readFileSync(schemaPath, 'utf8'));
  return {
    _db: db,
    prepare(sql) {
      return new Stmt(db, sql);
    },
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql) {
      db.exec(sql);
    },
  };
}
