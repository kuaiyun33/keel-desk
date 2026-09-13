import { promises as fs } from "node:fs";
import * as path from "node:path";
import { resolveDataDir } from "../config.js";
import { errDetail } from "../util/filelog.js";
import { runSceneConsolidation } from "./l2.js";
import { runPersona } from "./l3.js";
import { effectiveCfg } from "./runner.js";
function groupL0Sessions(records) {
  const bySession = /* @__PURE__ */ new Map();
  for (const r of records) {
    if (!r || typeof r.id !== "string" || typeof r.content !== "string") continue;
    if (r.role !== "user" && r.role !== "assistant") continue;
    if (!r.content.trim()) continue;
    const key = r.sessionId || "default";
    const arr = bySession.get(key) ?? [];
    arr.push({ id: r.id, role: r.role, content: r.content, timestamp: r.timestamp ?? 0 });
    bySession.set(key, arr);
  }
  const chunks = [];
  for (const [sessionId, messages] of bySession) {
    messages.sort((a, b) => a.timestamp - b.timestamp);
    chunks.push({ sessionId, messages });
  }
  chunks.sort((a, b) => a.messages[0].timestamp - b.messages[0].timestamp);
  return chunks;
}
function estimateCalls(sessions, messages, chars, maxInputChars) {
  if (messages === 0) return 0;
  const perChunk = Math.max(2e4, maxInputChars - 42e3);
  return Math.max(sessions, Math.ceil((chars + 64 * messages) / perChunk));
}
function idleStatus() {
  return {
    running: false,
    phase: "idle",
    done: 0,
    total: 0,
    sessionCount: 0,
    messageCount: 0,
    estCalls: 0,
    recordsBuilt: 0,
    cancelRequested: false,
    startedAt: null,
    finishedAt: null,
    error: null,
    archiveNote: null
  };
}
function stamp(now = /* @__PURE__ */ new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}
class RebuildController {
  constructor(ctx, cfg, stores, db, runner, logger, live) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.stores = stores;
    this.db = db;
    this.runner = runner;
    this.logger = logger;
    this.live = live;
  }
  status = idleStatus();
  chunks = [];
  cancelRequested = false;
  /** 快照时刻（收尾时按它区分重建产物与重建后新对话的记录）。 */
  rebuildStartMs = 0;
  /** 状态快照（idle 时附带实时 L0 预估，供确认弹窗显示成本）。 */
  getStatus() {
    if (this.status.phase === "idle") {
      const est = this.db.l0RebuildEstimate();
      return {
        ...this.status,
        sessionCount: est.sessions,
        messageCount: est.messages,
        estCalls: estimateCalls(est.sessions, est.messages, est.chars, effectiveCfg(this.cfg, this.live).llm.maxInputChars)
      };
    }
    return { ...this.status };
  }
  /** 内存中尚未处理的会话快照块数（收尾后应为 0——快照即弃，诊断/冒烟用）。 */
  get chunkCount() {
    return this.chunks.length;
  }
  /** 启动重建（校验后入队准备任务；真正的清库/归档在管线队列里串行执行，避开并发竞态）。 */
  start() {
    if (this.status.running) throw new Error("\u91CD\u5EFA\u5DF2\u5728\u8FDB\u884C\u4E2D");
    const est = this.db.l0RebuildEstimate();
    if (est.messages === 0) throw new Error("L0 \u65E0\u4EFB\u4F55\u6D88\u606F\uFF0C\u65E0\u9700\u91CD\u5EFA");
    this.cancelRequested = false;
    this.chunks = [];
    this.status = {
      ...idleStatus(),
      running: true,
      phase: "preparing",
      sessionCount: est.sessions,
      messageCount: est.messages,
      estCalls: estimateCalls(est.sessions, est.messages, est.chars, effectiveCfg(this.cfg, this.live).llm.maxInputChars),
      startedAt: Date.now()
    };
    this.runner.enqueueRebuildTask(() => this.prepare());
    this.logger.info(`[memory] \u91CD\u5EFA\u5F00\u59CB\uFF1A${est.sessions} \u4E2A\u4F1A\u8BDD / ${est.messages} \u6761 L0 \u6D88\u606F\uFF08\u9884\u8BA1 \u2265${this.status.estCalls} \u6B21\u62BD\u53D6\u8C03\u7528\uFF09`);
    return { ...this.status };
  }
  /** 请求取消：当前块完成后停止，已重建部分保留并照常收尾 L2/L3。 */
  requestCancel() {
    if (!this.status.running) return this.getStatus();
    this.cancelRequested = true;
    this.status.cancelRequested = true;
    this.logger.info("[memory] \u91CD\u5EFA\u53D6\u6D88\u5DF2\u8BF7\u6C42\uFF08\u5F53\u524D\u5757\u5B8C\u6210\u540E\u505C\u6B62\uFF09");
    return { ...this.status };
  }
  async prepare() {
    try {
      this.rebuildStartMs = Date.now();
      this.chunks = groupL0Sessions(this.db.listL0All());
      if (this.chunks.length === 0) {
        this.finish("failed", "L0 \u5FEB\u7167\u4E3A\u7A7A");
        return;
      }
      this.status.total = this.chunks.length;
      const archiveNote = await this.archiveDerived();
      this.status.archiveNote = archiveNote ?? null;
      if (!this.db.clearL1()) throw new Error("L1 \u68C0\u7D22\u5E93\u6E05\u7A7A\u5931\u8D25");
      this.stores.state.reset();
      await this.stores.state.save();
      await Promise.all([
        this.stores.scenes.chat.init(),
        this.stores.scenes.work.init(),
        this.stores.persona.chat.init(),
        this.stores.persona.work.init()
      ]);
      this.status.phase = "distilling";
      this.logger.info(`[memory] \u91CD\u5EFA\u51C6\u5907\u5B8C\u6210\uFF08\u5F52\u6863\uFF1A${archiveNote ?? "\u65E0\u65E7\u4EA7\u7269"}\uFF0C${this.chunks.length} \u4E2A\u4F1A\u8BDD\u5757\uFF09`);
      this.scheduleChunk(0);
    } catch (err) {
      this.finish("failed", `\u51C6\u5907\u9636\u6BB5\u5931\u8D25: ${errDetail(err)}`);
    }
  }
  /** 分块链：一次只挂一个重建块，跑完再挂下一块——正常轮次可随时插队。 */
  scheduleChunk(i) {
    if (this.cancelRequested || i >= this.chunks.length) {
      this.runner.enqueueRebuildTask(() => this.finalize());
      return;
    }
    const chunk = this.chunks[i];
    this.runner.enqueueRebuildTask(async () => {
      if (this.cancelRequested) {
        this.runner.enqueueRebuildTask(() => this.finalize());
        return;
      }
      try {
        const n = await this.runner.runRebuildTurn(chunk.sessionId, chunk.messages);
        this.status.recordsBuilt += n;
      } catch (err) {
        this.logger.warn(`[memory] \u91CD\u5EFA\u5757\u5931\u8D25\uFF08session=${chunk.sessionId}\uFF0C\u8DF3\u8FC7\u7EE7\u7EED\uFF09: ${errDetail(err)}`);
      }
      this.status.done = i + 1;
      this.scheduleChunk(i + 1);
    });
  }
  async finalize() {
    try {
      this.status.phase = "finalizing";
      const cfg = effectiveCfg(this.cfg, this.live);
      const liveNow = this.live.get();
      const distillOn = liveNow.enabled && liveNow.distill;
      if (cfg.l2.enabled && distillOn) {
        for (const family of ["chat", "work"]) {
          const fstate = this.runner.states[family];
          if (fstate.newMemoriesSinceL2 <= 0) continue;
          const leftovers = this.collectRebuildRecords(family);
          if (leftovers.length === 0) continue;
          try {
            const t = Date.now();
            const result = await runSceneConsolidation(this.ctx, cfg, this.stores.scenes[family], leftovers, this.logger, family);
            fstate.lastL2At = Date.now();
            fstate.newMemoriesSinceL2 = 0;
            if (result.personaRequestedReason) fstate.personaRequestedReason = result.personaRequestedReason;
            this.logger.info(`[memory] \u91CD\u5EFA\u6536\u5C3E L2 \u5B8C\u6210\uFF08family=${family}\uFF0C${Date.now() - t}ms\uFF0C${leftovers.length} \u6761\u6B8B\u4F59\u8BB0\u5F55\uFF09`);
          } catch (err) {
            this.logger.warn(`[memory] \u91CD\u5EFA\u6536\u5C3E L2 \u5931\u8D25\uFF08family=${family}\uFF09: ${errDetail(err)}`);
          }
        }
      }
      if (cfg.l3.enabled && distillOn) {
        for (const family of ["chat", "work"]) {
          try {
            const scenes = await this.stores.scenes[family].list();
            if (scenes.length === 0) continue;
            await runPersona(this.ctx, cfg, this.stores.scenes[family], this.stores.persona[family], this.runner.states[family], this.logger, family);
          } catch (err) {
            this.logger.warn(`[memory] \u91CD\u5EFA\u6536\u5C3E L3 \u5931\u8D25\uFF08family=${family}\uFF09: ${errDetail(err)}`);
          }
        }
      }
      await this.stores.state.save();
      this.finish(this.cancelRequested ? "cancelled" : "done", null);
    } catch (err) {
      this.finish("failed", `\u6536\u5C3E\u5931\u8D25: ${errDetail(err)}`);
    }
  }
  /**
   * 收集重建窗口内某族的记录：重建产物全部是新插入（updated==created），
   * 按 updated_time 倒序翻页、越过 rebuildStartMs 即停。
   */
  collectRebuildRecords(family) {
    const out = [];
    const PAGE = 200;
    for (let offset = 0; ; offset += PAGE) {
      const { items } = this.stores.l1.list({ family, limit: PAGE, offset });
      if (items.length === 0) break;
      let beyond = 0;
      for (const r of items) {
        if (r.createdAt >= this.rebuildStartMs) out.push(r);
        else beyond++;
      }
      if (beyond > 0 || items.length < PAGE) break;
    }
    return out;
  }
  finish(phase, error) {
    this.status.running = false;
    this.status.phase = phase;
    this.status.error = error;
    this.status.finishedAt = Date.now();
    this.chunks = [];
    const cost = this.status.finishedAt - (this.status.startedAt ?? this.status.finishedAt);
    this.logger.info(
      `[memory] \u91CD\u5EFA\u7ED3\u675F\uFF08${phase}\uFF09\uFF1A${this.status.done}/${this.status.total} \u4F1A\u8BDD\uFF0C\u4EA7\u51FA ${this.status.recordsBuilt} \u6761\u8BB0\u5F55\uFF0C\u8017\u65F6 ${Math.round(cost / 1e3)}s` + (error ? `\uFF0C\u9519\u8BEF\uFF1A${error}` : "")
    );
  }
  /** 归档旧派生层：records/ scenes/ persona-*.md 改名 .bak.<ts>。不存在则跳过。 */
  async archiveDerived() {
    const dataDir = resolveDataDir(this.cfg);
    const ts = stamp();
    const items = [
      [path.join(dataDir, "records"), path.join(dataDir, `records.bak.${ts}`)],
      [path.join(dataDir, "scenes"), path.join(dataDir, `scenes.bak.${ts}`)],
      [path.join(dataDir, "persona-chat.md"), path.join(dataDir, `persona-chat.md.bak.${ts}`)],
      [path.join(dataDir, "persona-work.md"), path.join(dataDir, `persona-work.md.bak.${ts}`)]
    ];
    const archived = [];
    for (const [from, to] of items) {
      try {
        await fs.access(from);
      } catch {
        continue;
      }
      await fs.rename(from, to);
      archived.push(path.basename(to));
    }
    return archived.length > 0 ? archived.join(", ") : void 0;
  }
}
export {
  RebuildController,
  estimateCalls,
  groupL0Sessions
};
