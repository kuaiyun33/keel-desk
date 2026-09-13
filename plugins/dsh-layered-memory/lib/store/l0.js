import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { EmbedHelper, NoopEmbeddingService } from "./embedding.js";
import { appendJsonl, dayKey, ensureDir, nowIso, readJsonl } from "./io.js";
import { rrfMerge } from "./search-utils.js";
import { isZeroVector } from "./sqlite.js";
const CANDIDATE_MULTIPLIER = 3;
class L0Store {
  constructor(dataDir, db, embed = new NoopEmbeddingService(), logger) {
    this.db = db;
    this.dir = path.join(dataDir, "conversations");
    this.legacyDir = path.join(dataDir, "l0");
    this.embedSvc = embed;
    this.helper = new EmbedHelper(embed, logger);
    this.logger = logger;
  }
  dir;
  legacyDir;
  helper;
  embedSvc;
  logger;
  async init() {
    await ensureDir(this.dir);
    await this.importLegacy();
    await this.rehydrateFromDailyJsonl();
  }
  /**
   * 与 L1 同款：库空而 conversations/*.jsonl 仍有行时回灌检索库。
   * 不清空、不改名事实源；upsert 幂等。
   */
  async rehydrateFromDailyJsonl() {
    if (this.db.countL0() > 0) return;
    try {
      const files = (await fs.readdir(this.dir).catch(() => [])).filter((f) => f.endsWith(".jsonl")).sort();
      let n = 0;
      for (const f of files) {
        const records = await readJsonl(path.join(this.dir, f));
        const valid = records.filter((r) => r && typeof r.id === "string" && r.content);
        if (valid.length === 0) continue;
        if (this.db.upsertL0Batch(valid)) n += valid.length;
      }
      if (n > 0) this.logger?.info(`[memory] \u4ECE conversations/*.jsonl \u56DE\u704C\u68C0\u7D22\u5E93 ${n} \u6761 L0`);
    } catch (err) {
      this.logger?.warn(`[memory] L0 \u6309\u5929 JSONL \u56DE\u704C\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  /** 旧版 l0/*.jsonl 一次性导入检索库，成功后目录改名 l0.imported/。 */
  async importLegacy() {
    if (!existsSync(this.legacyDir)) return;
    try {
      const files = await fs.readdir(this.legacyDir).catch(() => []);
      let imported = 0;
      let total = 0;
      for (const f of files.sort()) {
        if (!f.endsWith(".jsonl")) continue;
        const records = await readJsonl(path.join(this.legacyDir, f));
        const valid = records.filter((r) => r && typeof r.id === "string" && r.content);
        const badCount = records.length - valid.length;
        if (badCount > 0) {
          this.logger?.warn(`[memory] \u65E7\u7248 L0 \u6587\u4EF6 ${f} \u4E22\u5F03 ${badCount} \u6761\u574F\u884C\uFF08\u7F3A id/content\uFF09`);
        }
        if (valid.length > 0) {
          total += valid.length;
          if (this.db.upsertL0Batch(valid)) imported += valid.length;
        }
      }
      if (imported === total) {
        const renamed = await fs.rename(this.legacyDir, `${this.legacyDir}.imported`).then(
          () => true,
          () => false
        );
        if (renamed) {
          this.logger?.info(`[memory] \u65E7\u7248 L0 \u6570\u636E\u5DF2\u5BFC\u5165\u68C0\u7D22\u5E93 ${imported} \u6761\uFF08l0/ \u2192 l0.imported/\uFF09`);
        } else {
          this.logger?.warn("[memory] \u65E7\u7248 L0 \u5BFC\u5165\u5B8C\u6210\u4F46\u6539\u540D\u5931\u8D25\uFF08l0.imported/ \u5DF2\u5B58\u5728\uFF1F\uFF09\uFF0C\u4E0B\u6B21\u542F\u52A8\u4F1A\u91CD\u590D\u5BFC\u5165\uFF08\u5E42\u7B49\uFF0C\u65E0\u5BB3\uFF09");
        }
      } else {
        this.logger?.warn(`[memory] \u65E7\u7248 L0 \u5BFC\u5165\u4E0D\u5B8C\u6574\uFF08${imported}/${total}\uFF09\uFF0C\u4FDD\u7559\u539F\u76EE\u5F55\u4E0B\u6B21\u91CD\u8BD5`);
      }
    } catch (err) {
      this.logger?.warn(`[memory] \u65E7\u7248 L0 \u6570\u636E\u5BFC\u5165\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  async append(sessionId, messages) {
    if (messages.length === 0) return;
    const records = messages.map((m) => ({
      sessionId,
      recordedAt: nowIso(),
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp
    }));
    const byDay = /* @__PURE__ */ new Map();
    for (const r of records) {
      const k = dayKey(r.timestamp);
      const arr = byDay.get(k) ?? [];
      arr.push(r);
      byDay.set(k, arr);
    }
    for (const [day, list] of byDay) {
      await appendJsonl(path.join(this.dir, `${day}.jsonl`), list);
    }
    const vecs = await this.helper.batch(records.map((r) => r.content));
    if (!this.db.upsertL0Batch(records, vecs)) {
      this.logger?.error(
        `[memory] L0 \u68C0\u7D22\u5E93\u6279\u91CF\u5199\u5165\u5931\u8D25\uFF08${records.length} \u6761\uFF0CJSONL \u4E8B\u5B9E\u6E90\u5B8C\u597D\uFF09\uFF0C\u8FD9\u4E9B\u6D88\u606F\u6682\u4E0D\u53EF\u68C0\u7D22\uFF1B\u53EF\u5728\u8BBE\u7F6E\u9875\u8FD0\u884C\u300C\u91CD\u5EFA\u8BB0\u5FC6\u300D\u4FEE\u590D`
      );
    }
  }
  /** 今日已捕获消息数（SQL 计数，不再读整文件）。 */
  async countToday() {
    const d = /* @__PURE__ */ new Date();
    return this.db.countL0Since(new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString());
  }
  /** 该会话累计已捕获消息数（session-stats 数据源；索引 COUNT）。 */
  async countBySession(sessionId) {
    return this.db.countL0BySession(sessionId);
  }
  /** 该会话最近 n 条消息（时间升序；蒸馏背景参考用，按会话现查——ADR-0003）。 */
  async recentBySession(sessionId, limit) {
    return this.db.recentL0BySession(sessionId, limit);
  }
  /** 检索：FTS + 向量 hybrid（RRF 融合），返回按相关性排序的消息。 */
  async search(query, limit) {
    const caps = this.db.getCapabilities();
    if (!caps.ftsSearch && !caps.vectorSearch) return [];
    const candidateK = limit * CANDIDATE_MULTIPLIER;
    if (caps.vectorSearch && this.helper.vectorReady()) {
      const [ftsRaw, vec] = await Promise.all([
        Promise.resolve(this.db.searchL0Fts(query, candidateK)),
        this.helper.query(query)
      ]);
      const vecList = vec ? this.db.searchL0Vector(vec, candidateK) : [];
      const merged = rrfMerge([ftsRaw, vecList], (h) => h.id);
      return merged.map(({ rrfScore: _rrf, ...r }) => r).slice(0, limit);
    }
    return this.db.searchL0Fts(query, limit).map(({ score: _score, ...r }) => r);
  }
  /** 活切换嵌入源：同步换底层服务（嵌入源三态切换用）。 */
  setEmbeddingService(svc) {
    this.embedSvc = svc;
    this.helper.setService(svc);
  }
  /**
   * 增量重嵌入（同 L1Store.reindex：只补缺失向量，零向量记 skipped 并入 skip 集，
   * 不算失败、不阻塞同步标记——保证补齐判据收敛）。onProgress/shouldCancel
   * 供活切换（D5）的进度展示与取消。
   */
  async reindex(opts) {
    if (!this.helper.vectorReady()) return { written: 0, failed: 0, skipped: 0 };
    const items = this.db.getL0ForReindex(this.db.getVecSkipSet("l0"));
    const total = items.length;
    let done = 0;
    let written = 0;
    let failed = 0;
    let skipped = 0;
    let cancelled = false;
    const skippedNow = [];
    const CHUNK = 32;
    for (let i = 0; i < items.length; i += CHUNK) {
      if (opts?.shouldCancel?.()) {
        cancelled = true;
        break;
      }
      const chunk = items.slice(i, i + CHUNK);
      let vecs;
      try {
        vecs = await this.embedSvc.embedBatch(chunk.map((c) => c.text));
      } catch {
        failed += chunk.length;
        done += chunk.length;
        opts?.onProgress?.(done, total);
        continue;
      }
      const pending = [];
      chunk.forEach((c, j) => {
        if (isZeroVector(vecs[j])) {
          skipped++;
          skippedNow.push(c.id);
          return;
        }
        pending.push({ id: c.id, embedding: vecs[j] });
      });
      if (pending.length > 0) {
        const ok = this.db.updateL0VecBatch(pending, "");
        written += ok;
        failed += pending.length - ok;
      }
      done += chunk.length;
      opts?.onProgress?.(done, total);
    }
    if (skippedNow.length > 0) this.db.addVecSkippedIds("l0", skippedNow);
    return { written, failed, skipped, cancelled };
  }
}
export {
  L0Store
};
