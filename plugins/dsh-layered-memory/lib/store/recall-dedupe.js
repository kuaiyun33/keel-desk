import * as path from "node:path";
import { errDetail } from "../util/filelog.js";
import { atomicWriteJson, ensureDir, readJsonIfExists } from "./io.js";
const RECALL_DEDUPE_SESSION_CAP = 200;
const RECALL_DEDUPE_IDS_CAP = 512;
const PRUNE_MS = 90 * 24 * 36e5;
class RecallDedupeStore {
  constructor(dataDir, logger) {
    this.logger = logger;
    this.file = path.join(dataDir, "recall-dedupe.json");
    this.writeChain = this.init();
  }
  file;
  entries = /* @__PURE__ */ new Map();
  persistFailed = false;
  /** 串行化持久化写（避免并发原子写撞临时文件名）；init 链最前（先载入再落盘，防丢更新）。 */
  writeChain;
  /** 载入持久化映射（合并进内存——构造与载入之间发生的 mark 不丢）；失败降级内存态。 */
  async init() {
    const data = await readJsonIfExists(this.file);
    if (!data?.sessions || typeof data.sessions !== "object") return;
    const now = Date.now();
    let count = 0;
    for (const [sid, entry] of Object.entries(data.sessions)) {
      if (!Array.isArray(entry?.recordIds)) continue;
      if (now - (entry.updatedAt ?? 0) > PRUNE_MS) continue;
      const existing = this.entries.get(sid);
      if (existing) {
        for (const id of entry.recordIds) existing.ids.add(id);
        existing.updatedAt = Math.max(existing.updatedAt, entry.updatedAt ?? 0);
      } else {
        this.entries.set(sid, { ids: new Set(entry.recordIds), updatedAt: entry.updatedAt ?? now });
      }
      count++;
    }
    if (count > 0) this.logger?.info(`[memory] \u53EC\u56DE\u53BB\u91CD\u8BB0\u5F55\u8F7D\u5165 ${count} \u4E2A\u4F1A\u8BDD`);
  }
  /** 该会话的已注入集合（热路径同步读；未出现过的会话返回空集合，惰性建条）。 */
  seen(sessionId) {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { ids: /* @__PURE__ */ new Set(), updatedAt: 0 };
      this.entries.set(sessionId, entry);
    }
    return entry.ids;
  }
  /** 标记本轮实际注入的记录 id（写穿；调用方保证只传模型真实看到的条目）。 */
  mark(sessionId, recordIds) {
    if (recordIds.length === 0) return;
    const ids = this.seen(sessionId);
    for (const id of recordIds) ids.add(id);
    while (ids.size > RECALL_DEDUPE_IDS_CAP) {
      const oldest = ids.values().next().value;
      if (oldest === void 0) break;
      ids.delete(oldest);
    }
    const entry = this.entries.get(sessionId);
    entry.updatedAt = Date.now();
    this.writeChain = this.writeChain.then(() => this.persist());
  }
  /** 清空该会话的记录（compact/clear 后上下文已丢失，记忆需可重新注入）。 */
  reset(sessionId) {
    if (!this.entries.has(sessionId)) return;
    this.entries.delete(sessionId);
    this.writeChain = this.writeChain.then(() => this.persist());
  }
  /** 等待在途持久化写完成（测试/停机用）。 */
  flush() {
    return this.writeChain;
  }
  async persist() {
    try {
      await ensureDir(path.dirname(this.file));
      await atomicWriteJson(this.file, this.serialize());
      this.persistFailed = false;
    } catch (err) {
      if (!this.persistFailed) {
        this.persistFailed = true;
        this.logger?.warn(`[memory] \u53EC\u56DE\u53BB\u91CD\u6301\u4E45\u5316\u5931\u8D25\uFF08\u964D\u7EA7\u5185\u5B58\u6001\uFF09: ${errDetail(err)}`);
      }
    }
  }
  serialize() {
    const now = Date.now();
    for (const [sid, e] of this.entries) {
      if (now - e.updatedAt > PRUNE_MS && e.updatedAt > 0) this.entries.delete(sid);
    }
    while (this.entries.size > RECALL_DEDUPE_SESSION_CAP) {
      let oldest;
      let oldestAt = Infinity;
      for (const [sid, e] of this.entries) {
        if (e.updatedAt > 0 && e.updatedAt < oldestAt) {
          oldest = sid;
          oldestAt = e.updatedAt;
        }
      }
      if (oldest === void 0) break;
      this.entries.delete(oldest);
    }
    const sessions = {};
    for (const [sid, e] of this.entries) {
      if (e.ids.size === 0) continue;
      sessions[sid] = { recordIds: [...e.ids], updatedAt: e.updatedAt };
    }
    return { version: 1, sessions };
  }
}
export {
  RECALL_DEDUPE_IDS_CAP,
  RECALL_DEDUPE_SESSION_CAP,
  RecallDedupeStore
};
