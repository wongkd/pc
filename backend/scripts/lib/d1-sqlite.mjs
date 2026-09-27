/**
 * D1 兼容的本地 SQLite 适配器（Node 运行时夹具）。
 *
 * ── 为什么需要它 ──
 * 后端要在国内轻量服务器上自建（小程序 request 域名必须境内 + 已备案），
 * 而生产代码此刻跑在 workerd 的 D1 上。要回答「换到轻量后内存够不够」，
 * 必须先让**同一份 Worker 源码**能在 Node 进程里真实跑起来。
 *
 * `backend/src` 本身是运行时无关的（无 `cloudflare:` 导入、无 `node:` 导入），
 * 唯一的外部依赖就是 `env.DB`（D1）与 `env.BUCKET`（R2）。把这两个绑定换成
 * Node 侧实现，业务代码一行都不用改。
 *
 * ── 实现依据（2026-09-27 实测 node:sqlite，Node 22.22.2，非推测）──
 *   · `StatementSync.columns()` 在语句不返回行时给 `[]`，返回行时给列定义
 *     ⇒ 这是区分「读」与「写」的可靠依据，不用猜 SQL 首关键字。
 *   · `INSERT.all()` 静默返回 `[]` 且**丢掉 lastInsertRowid**；`SELECT.run()` 拿不到行
 *     ⇒ 读写两条路必须分开走，不能混用。
 *   · `lastInsertRowid` 是 `number`（不是 BigInt），与 D1 的 `meta.last_row_id` 口径一致。
 *   · **布尔与 undefined 绑定会抛错**（`Provided value cannot be bound ...`）
 *     ⇒ 见下方 `normalizeParam` 的取舍说明。
 *
 * ── 与 D1 的已知差异（必须知道，不能当没看见）──
 *   1. 参数强制转换：`undefined → null`、`true/false → 1/0`。
 *      原生 node:sqlite 会拒绝这两种值。若 D1 也拒绝，则本地会「假通过」。
 *      为免静默掩盖，转换次数会记在 `adapter.coercions` 上，宿主启动时打印；
 *      次数不为 0 就说明「这里存在口径差异，上生产前必须复核」。
 *   2. `batch()` 用显式 BEGIN/COMMIT 模拟 D1 的「整批一个事务」，语义一致，
 *      但**并发**行为不同：D1 是远端服务，这里是单进程单连接。真并发写入一致性
 *      **本夹具测不了**，不能拿它替代压测。
 *   3. `meta.rows_read` / `rows_written` / `size_after` / `changed_db` 填的是
 *      近似值（SQLite 不暴露这些统计）。生产代码目前只消费 `last_row_id`。
 *
 * 边界：只跑本机，不连远端、不 deploy、不读生产数据。
 */

import { DatabaseSync } from 'node:sqlite'

/**
 * 把 JS 值转成 node:sqlite 能接受的绑定值。
 *
 * 取舍：这里**故意**比原生宽松（原生对布尔/undefined 直接抛错）。
 * 更严的写法能让口径差异更早暴露，代价是夹具会很脆；
 * 更松的写法会掩盖问题。折中是：宽松 + 计数 + 启动时显式打印，让差异可见。
 * 见文件头「与 D1 的已知差异」第 1 条。
 */
function normalizeParam(value, counter) {
  if (value === undefined) {
    counter.undefinedToNull += 1
    return null
  }
  if (typeof value === 'boolean') {
    counter.booleanToInt += 1
    return value ? 1 : 0
  }
  return value
}

/** 一条已绑定参数的语句。D1 的 `bind()` 返回新对象，不改原对象，这里保持一致。 */
class LocalStatement {
  constructor(db, sql, params, counter) {
    this.db = db
    this.sql = sql
    this.params = params
    this.counter = counter
  }

  bind(...values) {
    // D1 允许链式再 bind 覆盖；这里同样返回新对象，避免「绑定泄漏到下一次调用」。
    return new LocalStatement(this.db, this.sql, values, this.counter)
  }

  /** 该语句是否返回行。依据实测：columns() 为空数组即「不返回行」。 */
  _returnsRows(stmt) {
    const columns = stmt.columns()
    return Array.isArray(columns) && columns.length > 0
  }

  _prepared() {
    return this.db.prepare(this.sql)
  }

  _bound() {
    return this.params.map((v) => normalizeParam(v, this.counter))
  }

  _meta(stmt, lastRowId, changes, duration) {
    return {
      duration,
      // D1 的口径：写入语句给 last_row_id，读语句给 0。生产代码只在前者消费它。
      last_row_id: lastRowId ?? 0,
      changes,
      changed_db: changes > 0,
      rows_read: 0,
      rows_written: changes,
      // SQLite 不暴露库体积；给 -1 明确表示「不可用」，不编造数字。
      size_after: -1,
    }
  }

  async _read() {
    const started = performance.now()
    const stmt = this._prepared()
    const results = stmt.all(...this._bound())
    return { results, success: true, meta: this._meta(stmt, 0, 0, performance.now() - started) }
  }

  async _write() {
    const started = performance.now()
    const stmt = this._prepared()
    const info = stmt.run(...this._bound())
    const changes = Number(info.changes ?? 0)
    const lastRowId = Number(info.lastInsertRowid ?? 0)
    return { results: [], success: true, meta: this._meta(stmt, lastRowId, changes, performance.now() - started) }
  }

  async _runLikeD1() {
    const stmt = this._prepared()
    return this._returnsRows(stmt) ? this._read() : this._write()
  }

  async all() {
    return this._read()
  }

  /**
   * D1 的 `first()`：无行返回 null；给了列名则返回该列的值。
   * 注意 D1 在这里**不**做类型转换，列名写错会得到 null 而不是报错 —— 保持一致。
   */
  async first(columnName) {
    const started = performance.now()
    const stmt = this._prepared()
    const row = stmt.get(...this._bound())
    if (row == null) return null
    if (columnName === undefined) return row
    return Object.prototype.hasOwnProperty.call(row, columnName) ? row[columnName] : null
  }

  async run() {
    return this._write()
  }

  /** D1 的 `raw()`：返回数组的数组。node:sqlite 靠 setReturnArrays 直接支持。 */
  async raw() {
    const stmt = this._prepared()
    stmt.setReturnArrays(true)
    return stmt.all(...this._bound())
  }
}

/** D1 绑定的最小兼容实现。只实现生产代码实际用到的部分，其余不假装支持。 */
export class LocalD1Database {
  constructor(database) {
    this.db = database
    this.counter = { undefinedToNull: 0, booleanToInt: 0 }
  }

  /** 参数被强制转换的总次数。宿主应打印它，让口径差异可见。 */
  get coercions() {
    return { ...this.counter }
  }

  prepare(sql) {
    return new LocalStatement(this.db, sql, [], this.counter)
  }

  /**
   * D1 的 batch 语义是「整批一个事务」。用显式 BEGIN/COMMIT 对齐；
   * 任一条失败就整批回滚，与 D1 一致（资金/库存动作依赖这个原子性）。
   */
  async batch(statements) {
    const results = []
    this.db.exec('BEGIN')
    try {
      for (const statement of statements) {
        if (!(statement instanceof LocalStatement)) {
          throw new TypeError('batch() 只接受本适配器 prepare() 出来的语句')
        }
        results.push(await statement._runLikeD1())
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return results
  }

  /**
   * D1 的 `exec()`：一次执行多条语句，返回 { count, duration }。
   * 生产代码目前不调它；实现只为让夹具在面对同一份源码时不缺方法。
   */
  async exec(sql) {
    const started = performance.now()
    this.db.exec(sql)
    return { count: 0, duration: performance.now() - started }
  }

  close() {
    this.db.close()
  }
}

/**
 * 建一个 D1 兼容库。
 *
 * @param {string} filename `:memory:` 为内存库；给路径则为落盘库（压测要用落盘，
 *        否则测不到「数据量增长后的内存水位」这件事）。
 */
export function createLocalD1(filename = ':memory:') {
  const db = new DatabaseSync(filename)
  // 与 D1 对齐：外键约束打开。生产数据靠它保证引用完整性，夹具也必须开，
  // 否则本地「跑得通」的写入在生产会被拒。
  db.exec('PRAGMA foreign_keys = ON')
  if (filename !== ':memory:') {
    // 落盘库用 WAL，避免读写互相阻塞；内存库该 PRAGMA 无效但不报错。
    db.exec('PRAGMA journal_mode = WAL')
  }
  db.exec('PRAGMA busy_timeout = 5000')
  return new LocalD1Database(db)
}
