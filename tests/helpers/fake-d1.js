// テスト用：Cloudflare D1 と同じ使い方ができる、Node.js の SQLite（node:sqlite）を使った作り物
import { DatabaseSync } from 'node:sqlite';

const plain = (rows) => rows.map((r) => ({ ...r }));

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  let queries = 0;
  function stmt(sql, params = []) {
    return {
      bind: (...p) => stmt(sql, p),
      async first(col) {
        queries += 1;
        const r = db.prepare(sql).get(...params);
        if (!r) return null;
        const o = { ...r };
        return col ? o[col] : o;
      },
      async all() {
        queries += 1;
        return { results: plain(db.prepare(sql).all(...params)), success: true, meta: {} };
      },
      async run() {
        queries += 1;
        const r = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: r.changes } };
      },
      run_: () => {
        const st = db.prepare(sql);
        if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: plain(st.all(...params)) };
        st.run(...params);
        return { results: [] };
      },
    };
  }
  return {
    raw: db,
    get queries() { return queries; },
    prepare: (sql) => stmt(sql),
    async batch(list) {
      queries += list.length;
      db.exec('BEGIN');
      try {
        const out = list.map((s) => s.run_());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    // D1 の exec は改行ごとに1文。同じように1行ずつ実行する
    async exec(sql) {
      const lines = sql.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const l of lines) db.exec(l);
      return { count: lines.length };
    },
  };
}
