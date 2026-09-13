import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { familyForType } from "../types.js";
import { EmbedHelper, NoopEmbeddingService } from "./embedding.js";
import { appendJsonl, atomicWriteText, dayKey, ensureDir, readJsonl } from "./io.js";
import { applyDecayWeight, RRF_K, rrfMerge } from "./search-utils.js";
import { isZeroVector } from "./sqlite.js";
const CANDIDATE_MULTIPLIER = 3;
class L1Store {
  constructor(dataDir, db, embed = new NoopEmbeddingService(), strategy = "hybrid", logger, decayHalfLifeDays) {
    this.db = db;
    this.strategy = strategy;
    this.recordsDir = path.join(dataDir, "records");
    this.legacyFile = path.join(dataDir, "l1", "records.jsonl");
    this.embedSvc = embed;
    this.helper = new EmbedHelper(embed, logger);
    this.logger = logger;
    this.decayHalfLifeDays = decayHalfLifeDays ?? 30;
  }
  recordsDir;
  legacyFile;
  helper;
  embedSvc;
  logger;
  /** 时效衰减半衰期（天；0=关）。 */
  decayHalfLifeDays;
  async init() {
    await ensureDir(this.recordsDir);
    await this.importLegacy();
    await this.rehydrateFromDailyJsonl();
  }
  /**
   * 按天 JSONL 是事实源，SQLite 是检索引擎。清空库 / 换包 / 关捕获后
   * 若库空而 records/*.jsonl 仍有行，工作台与 memory_search 会显示 0 条。
   * 启动时库空则回灌，upsert 幂等，不改名事实源。
   */
  async rehydrateFromDailyJsonl() {
    if (this.db.countL1() > 0) return;
    try {
      const files = (await fs.readdir(this.recordsDir).catch(() => [])).filter((f) => f.endsWith(".jsonl")).sort();
      let n = 0;
      for (const f of files) {
        const records = await readJsonl(path.join(this.recordsDir, f));
        const valid = records.filter((r) => r && typeof r.id === "string" && r.content);
        if (valid.length === 0) continue;
        if (this.db.upsertL1Batch(valid)) n += valid.length;
      }
      if (n > 0) this.logger?.info(`[memory] \u4ECE records/*.jsonl \u56DE\u704C\u68C0\u7D22\u5E93 ${n} \u6761 L1`);
    } catch (err) {
      this.logger?.warn(`[memory] L1 \u6309\u5929 JSONL \u56DE\u704C\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  /** 旧版单文件 records.jsonl 一次性导入检索库，成功后改名 .imported。 */
  async importLegacy() {
    if (!existsSync(this.legacyFile)) return;
    try {
      const records = await readJsonl(this.legacyFile);
      const valid = records.filter((r) => r && typeof r.id === "string" && r.content);
      const badCount = records.length - valid.length;
      let n = 0;
      if (valid.length > 0 && this.db.upsertL1Batch(valid)) n = valid.length;
      if (n === valid.length) {
        const renamed = await fs.rename(this.legacyFile, `${this.legacyFile}.imported`).then(
          () => true,
          () => false
        );
        if (renamed) {
          this.logger?.info(
            `[memory] \u65E7\u7248 L1 \u6570\u636E\u5DF2\u5BFC\u5165\u68C0\u7D22\u5E93 ${n} \u6761${badCount > 0 ? `\uFF08\u53E6\u4E22\u5F03 ${badCount} \u6761\u574F\u884C\uFF09` : ""}\uFF08l1/records.jsonl \u2192 .imported\uFF09`
          );
        } else {
          this.logger?.warn("[memory] \u65E7\u7248 L1 \u5BFC\u5165\u5B8C\u6210\u4F46\u6539\u540D\u5931\u8D25\uFF0C\u4E0B\u6B21\u542F\u52A8\u4F1A\u91CD\u590D\u5BFC\u5165\uFF08upsert \u5E42\u7B49\uFF0C\u65E0\u5BB3\uFF09");
        }
      } else {
        this.logger?.warn(`[memory] \u65E7\u7248 L1 \u5BFC\u5165\u4E0D\u5B8C\u6574\uFF08${n}/${valid.length}\uFF09\uFF0C\u4FDD\u7559\u539F\u6587\u4EF6\u4E0B\u6B21\u91CD\u8BD5`);
      }
    } catch (err) {
      this.logger?.warn(`[memory] \u65E7\u7248 L1 \u6570\u636E\u5BFC\u5165\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  get size() {
    return this.db.countL1();
  }
  /** 全量读取（调试/迁移用；检索请走 search）。 */
  all() {
    return this.db.getAllL1();
  }
  /** 按 id 精确取记录（去重决策的版本号查询用，避免全表扫描）。 */
  getByIds(ids) {
    return this.db.getL1ByIds(ids);
  }
  /** 新记忆落盘：JSONL 按天追加（事实源）+ 检索库 upsert + 向量。 */
  async appendNew(records) {
    if (records.length === 0) return;
    for (const r of records) {
      if (!r.family) r.family = familyForType(r.type);
    }
    const byDay = /* @__PURE__ */ new Map();
    for (const r of records) {
      const k = dayKey(r.createdAt || Date.now());
      const arr = byDay.get(k) ?? [];
      arr.push(r);
      byDay.set(k, arr);
    }
    for (const [day, list] of byDay) {
      await appendJsonl(path.join(this.recordsDir, `${day}.jsonl`), list);
    }
    const vecs = await this.helper.batch(records.map((r) => r.content));
    if (!this.db.upsertL1Batch(records, vecs)) {
      this.logger?.error(
        `[memory] L1 \u68C0\u7D22\u5E93\u6279\u91CF\u5199\u5165\u5931\u8D25\uFF08${records.length} \u6761\uFF0CJSONL \u4E8B\u5B9E\u6E90\u5B8C\u597D\uFF09\uFF0C\u8FD9\u6279\u8BB0\u5FC6\u6682\u4E0D\u53EF\u68C0\u7D22\uFF1B\u53EF\u5728\u8BBE\u7F6E\u9875\u8FD0\u884C\u300C\u91CD\u5EFA\u8BB0\u5FC6\u300D\u4FEE\u590D`
      );
    }
  }
  /** 去重 update/merge 产出的记录：只更新检索库（JSONL 事实源不改写，官方语义）。 */
  async upsert(record) {
    if (!record.family) record.family = familyForType(record.type);
    const vec = (await this.helper.batch([record.content]))[0];
    if (!this.db.upsertL1(record, vec)) {
      this.logger?.error(
        `[memory] L1 \u68C0\u7D22\u5E93\u5199\u5165\u5931\u8D25 id=${record.id}\uFF08JSONL \u4E8B\u5B9E\u6E90\u5B8C\u597D\uFF09\uFF0C\u8BE5\u8BB0\u5FC6\u6682\u4E0D\u53EF\u68C0\u7D22\uFF0C\u91CD\u5EFA\u53EF\u4FEE\u590D`
      );
    }
  }
  /** 活切换嵌入源：同步换底层服务（嵌入源三态切换用）。 */
  setEmbeddingService(svc) {
    this.embedSvc = svc;
    this.helper.setService(svc);
  }
  /**
   * 显式改写一条已有记忆（工作台编辑 / 同事实覆盖）：
   * 检索库 upsert 同一 id，JSONL 事实源按 id 原地替换（找不到则追加当天）。
   * 与蒸馏 merge（新 id + 删旧）不同——用户改的是「这一条」，id 必须稳住。
   */
  async rewrite(record) {
    if (!record.family) record.family = familyForType(record.type);
    const vec = (await this.helper.batch([record.content]))[0];
    if (!this.db.upsertL1(record, vec)) {
      this.logger?.error(
        `[memory] L1 \u68C0\u7D22\u5E93\u6539\u5199\u5931\u8D25 id=${record.id}\uFF08\u5C06\u4ECD\u5C1D\u8BD5\u540C\u6B65 JSONL\uFF09\uFF0C\u8BE5\u8BB0\u5FC6\u53EF\u80FD\u6682\u4E0D\u53EF\u68C0\u7D22`
      );
    }
    await this.rewriteDailyJsonl(record);
  }
  async deleteBatch(ids) {
    this.db.deleteL1Batch(ids);
    await this.tombstoneDailyJsonl(ids);
  }
  /** 按 id 在按天 JSONL 里替换整行；未命中则追加到当天（与删除同款：事实源必须跟检索库一致）。 */
  async rewriteDailyJsonl(record) {
    let found = false;
    try {
      const files = (await fs.readdir(this.recordsDir).catch(() => [])).filter((f) => f.endsWith(".jsonl"));
      for (const f of files) {
        const file = path.join(this.recordsDir, f);
        const records = await readJsonl(file);
        let changed = false;
        const next = records.map((r) => {
          if (r && typeof r.id === "string" && r.id === record.id) {
            found = true;
            changed = true;
            return record;
          }
          return r;
        });
        if (!changed) continue;
        const payload = next.map((l) => JSON.stringify(l)).join("\n");
        await atomicWriteText(file, payload ? `${payload}
` : "");
      }
    } catch (err) {
      this.logger?.warn(`[memory] L1 JSONL \u6539\u5199\u540C\u6B65\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!found) {
      await appendJsonl(path.join(this.recordsDir, `${dayKey(record.updatedAt || Date.now())}.jsonl`), [record]);
    }
  }
  /**
   * 按天 JSONL 只增不改。删除必须从事实源抹掉对应行，否则空库启动会把
   * 已删记忆回灌回来（工作台点删除后重启又出现）。
   */
  async tombstoneDailyJsonl(ids) {
    if (ids.length === 0) return;
    const want = new Set(ids);
    try {
      const files = (await fs.readdir(this.recordsDir).catch(() => [])).filter((f) => f.endsWith(".jsonl"));
      for (const f of files) {
        const file = path.join(this.recordsDir, f);
        const records = await readJsonl(file);
        const kept = records.filter((r) => !(r && typeof r.id === "string" && want.has(r.id)));
        if (kept.length === records.length) continue;
        const payload = kept.map((l) => JSON.stringify(l)).join("\n");
        await atomicWriteText(file, payload ? `${payload}
` : "");
      }
    } catch (err) {
      this.logger?.warn(`[memory] L1 JSONL \u5220\u9664\u540C\u6B65\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  /**
   * 三策略检索（自动召回与 memory_search 工具共用接缝）。
   * embedding 不可用时自动降级 keyword；type 后置过滤；
   * scoreThreshold 仅对 keyword/embedding 单路策略生效——hybrid 按官方语义
   * 融合完整列表（融合分已归一化 0~1，可直接用于展示/过滤）。
   */
  async search(query, limit, opts) {
    const caps = this.db.getCapabilities();
    const canVec = caps.vectorSearch && this.helper.vectorReady();
    let strategy = this.strategy;
    if (strategy !== "keyword" && !canVec) strategy = caps.ftsSearch ? "keyword" : "none";
    const candidateK = limit * CANDIDATE_MULTIPLIER;
    const threshold = opts?.scoreThreshold ?? 0;
    if (strategy === "none") return [];
    if (strategy === "keyword") {
      const fts = this.db.searchL1Fts(query, candidateK, opts?.family);
      return this.postProcess(this.applyDecay(applyFtsThreshold(fts, threshold, limit)), opts?.type, limit);
    }
    if (strategy === "embedding") {
      const vec = await this.helper.query(query, opts?.embeddingTimeoutMs);
      if (!vec) {
        const fts = this.db.searchL1Fts(query, candidateK, opts?.family);
        return this.postProcess(this.applyDecay(applyFtsThreshold(fts, threshold, limit)), opts?.type, limit);
      }
      const vecHits = this.db.searchL1Vector(vec, candidateK, opts?.family);
      return this.postProcess(this.applyDecay(filterScore(vecHits, threshold)), opts?.type, limit);
    }
    const [ftsList, vecRaw] = await Promise.all([
      Promise.resolve(this.db.searchL1Fts(query, candidateK, opts?.family)),
      this.helper.query(query, opts?.embeddingTimeoutMs)
    ]);
    const vecList = vecRaw ? this.db.searchL1Vector(vecRaw, candidateK, opts?.family) : [];
    const merged = rrfMerge([ftsList, vecList], (h) => h.id);
    return this.postProcess(
      this.applyDecay(merged.map(({ rrfScore, ...h }) => ({ ...h, score: normalizeRrf(rrfScore) }))),
      opts?.type,
      limit
    );
  }
  /**
   * 时效衰减加权（#29）：三路共用的读路径后处理——阈值过滤之后、截断之前
   * （才能轮转名额，而不只是重排已截断的集合）。updated_at 经主表批量点查
   * 回填（FTS 表无该列；候选池 ≤ limit×3 条主键查询，微秒级）。关闭时零开销。
   */
  applyDecay(hits) {
    if (!(this.decayHalfLifeDays > 0) || hits.length === 0) return hits;
    const updatedAtById = /* @__PURE__ */ new Map();
    for (const r of this.db.getL1ByIds(hits.map((h) => h.id))) {
      if (Number.isFinite(r.updatedAt)) updatedAtById.set(r.id, r.updatedAt);
    }
    return applyDecayWeight(hits, this.decayHalfLifeDays, (h) => updatedAtById.get(h.id));
  }
  /** 浏览列表（UI 用）：无关键词时按更新时间倒序分页；since 为 ISO 时间下限（可选）。 */
  list(opts) {
    return this.db.listL1(opts);
  }
  /** 近 N 天逐日更新计数（工作台活动图；索引化 GROUP BY）。 */
  countByDay(sinceIso) {
    return this.db.countL1ByDay(sinceIso);
  }
  /** 场景名去重列表（UI 筛选器数据源）。 */
  distinctScenes() {
    return this.db.distinctL1Scenes();
  }
  /**
   * 去重候选召回（官方 3 级）：空库跳过 → 向量优先 → FTS 兜底。
   * 传入 family 时只在同族记录里召回（去重永不跨族）。
   */
  async searchCandidates(query, limit, family) {
    if (this.db.countL1() === 0) return [];
    const caps = this.db.getCapabilities();
    if (caps.vectorSearch && this.helper.vectorReady()) {
      try {
        const vec = await this.helper.query(query);
        if (vec) {
          const hits = this.db.searchL1Vector(vec, limit, family);
          if (hits.length > 0) return this.db.getL1ByIds(hits.map((h) => h.id));
        }
      } catch (err) {
        this.logger?.warn(`[memory] \u5411\u91CF\u5019\u9009\u53EC\u56DE\u5931\u8D25\uFF0C\u964D\u7EA7 FTS: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const fts = this.db.searchL1Fts(query, limit * 2, family);
    return this.db.getL1ByIds(fts.map((h) => h.id));
  }
  /**
   * 增量重嵌入（embedding 配置变化 / 周期性补齐用）：只处理缺失向量的记录，
   * 排除已判定"当前 provider 不可嵌入"的 skip 集。返回写入/失败/跳过数——
   * failed > 0 时调用方不应标记 meta 同步完成；skipped（零向量）不算失败、
   * 不阻塞同步标记（否则补齐判据永不收敛，每 30 分钟全量重嵌死循环）。
   * onProgress/shouldCancel 供活切换（D5）的进度展示与取消。
   */
  async reindex(opts) {
    if (!this.helper.vectorReady()) return { written: 0, failed: 0, skipped: 0 };
    const items = this.db.getL1ForReindex(this.db.getVecSkipSet("l1"));
    const total = items.length;
    let done = 0;
    let written = 0;
    let failed = 0;
    let skipped = 0;
    let cancelled = false;
    const skippedNow = [];
    const CHUNK = 16;
    for (let i = 0; i < items.length; i += CHUNK) {
      if (opts?.shouldCancel?.()) {
        cancelled = true;
        break;
      }
      const chunk = items.slice(i, i + CHUNK);
      let vecs;
      try {
        vecs = await this.embedSvc.embedBatch(chunk.map((c) => c.content));
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
        const ok = this.db.updateL1VecBatch(pending);
        written += ok;
        failed += pending.length - ok;
      }
      done += chunk.length;
      opts?.onProgress?.(done, total);
    }
    if (skippedNow.length > 0) this.db.addVecSkippedIds("l1", skippedNow);
    return { written, failed, skipped, cancelled };
  }
  postProcess(hits, type, limit) {
    const filtered = type ? hits.filter((h) => h.type === type) : hits;
    return filtered.slice(0, limit);
  }
}
function normalizeRrf(rrfScore) {
  return rrfScore * (RRF_K + 1) / 2;
}
function applyFtsThreshold(hits, threshold, maxResults) {
  if (threshold <= 0) return hits;
  const filtered = hits.filter((h) => h.score >= threshold);
  if (filtered.length === 0 && hits.length > 0 && hits.length <= maxResults) return hits;
  return filtered;
}
function filterScore(hits, threshold) {
  if (threshold <= 0) return hits;
  return hits.filter((h) => h.score >= threshold);
}
export {
  L1Store
};
