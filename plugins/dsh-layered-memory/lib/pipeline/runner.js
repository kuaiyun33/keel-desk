import { resolveDataDir } from "../config.js";
import {
  emptyPending,
  freshWarmup,
  groupPendingBySession,
  loadPending,
  PENDING_MODES,
  pendingPathFor,
  savePending
} from "../store/pending.js";
import { errDetail } from "../util/filelog.js";
import {
  advanceWarmupThreshold,
  effectiveExtractThreshold,
  extractionBackoffMs,
  idleSessionsToFlush,
  modeSwitchAction,
  pickSessionBackground
} from "./trigger.js";
import { runExtraction } from "./l1.js";
import { runSceneConsolidation } from "./l2.js";
import { runPersona } from "./l3.js";
function pickNextTaskIndex(tasks) {
  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i].kind === "live") return i;
  }
  return 0;
}
function effectiveCfg(cfg, live) {
  const s = live?.get();
  const eff = s?.reasoningEffort ?? "";
  const pinned = Boolean(cfg.llm?.provider && cfg.llm?.model);
  const chain = s?.distillChain?.length ? s.distillChain : [];
  const chainMode = chain.length > 0 && !pinned;
  const chainEffort = chainMode && chain[0].reasoningEffort ? chain[0].reasoningEffort : null;
  const chainFallbacks = chainMode ? chain.slice(1).map((e) => ({ provider: e.provider, model: e.model, reasoningEffort: e.reasoningEffort || "" })) : null;
  const override = chainMode && chain[0].provider && chain[0].model ? { provider: chain[0].provider, model: chain[0].model } : !chain.length && s && !pinned && s.distillProvider && s.distillModel ? { provider: s.distillProvider, model: s.distillModel } : null;
  const b = s?.distillBudgets;
  const budgets = b && (b.extract > 0 || b.dedup > 0 || b.l2 > 0 || b.l3 > 0) ? {
    ...b.extract > 0 ? { extract: b.extract } : {},
    ...b.dedup > 0 ? { dedup: b.dedup } : {},
    ...b.l2 > 0 ? { l2: b.l2 } : {},
    ...b.l3 > 0 ? { l3: b.l3 } : {}
  } : null;
  const lc = s?.distillLayerChains;
  const layerPick = lc && !pinned ? {
    ...lc.l1?.length ? { l1: lc.l1 } : {},
    ...lc.l2?.length ? { l2: lc.l2 } : {},
    ...lc.l3?.length ? { l3: lc.l3 } : {}
  } : null;
  const layerChains = layerPick && Object.keys(layerPick).length ? layerPick : null;
  const maxInput = s && s.distillMaxInputChars > 0 ? s.distillMaxInputChars : null;
  const fallbacksTakeover = !chainMode && eff && cfg.llm?.fallbacks?.length ? cfg.llm.fallbacks.map((f) => ({ ...f, reasoningEffort: eff })) : null;
  const effortInject = live && !chainMode && (eff !== "" || Boolean(cfg.llm?.reasoningEffort)) ? { reasoningEffort: eff } : null;
  if (!override && !budgets && !maxInput && !fallbacksTakeover && !chainEffort && !chainFallbacks && !effortInject && !layerChains) return cfg;
  return {
    ...cfg,
    llm: {
      ...cfg.llm,
      ...effortInject ?? {},
      ...override ?? {},
      ...budgets ? { budgets } : {},
      ...maxInput ? { maxInputChars: maxInput } : {},
      ...fallbacksTakeover ? { fallbacks: fallbacksTakeover } : {},
      ...chainEffort ? { primaryEffort: chainEffort } : {},
      ...chainFallbacks ? { fallbacks: chainFallbacks } : {},
      ...layerChains ? { layerChainsRuntime: layerChains } : {}
    }
  };
}
const PENDING_BUCKET_CAP = 200;
const SESSION_PRODUCED_CAP = 400;
const STARTUP_RETRY_DELAY_MS = 2e4;
const IDLE_TICK_MS = 3e4;
class MemoryRunner {
  constructor(ctx, cfg, stores, logger, live, modes) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.stores = stores;
    this.logger = logger;
    this.live = live;
    this.modes = modes;
    this.pendingFile = pendingPathFor(resolveDataDir(cfg));
  }
  tasks = [];
  draining = false;
  /** 停止标志（dispose 序置位）：不再取新任务；进行中任务自然收尾，其 DB 写入失败由各层兜底捕获。 */
  stopped = false;
  pending = emptyPending();
  /** 各档位桶渐进阈值（1 起步翻倍至稳态毕业；ADR-0003，随 pending.json 持久化）。 */
  warmup = freshWarmup();
  /** 每会话最后活动时间（闲置兜底判定用）。 */
  lastActivity = /* @__PURE__ */ new Map();
  /** 每会话累计产出 L1 条数与最近蒸馏时间（session-stats 数据源；LRU 上限防泄漏）。 */
  sessionProduced = /* @__PURE__ */ new Map();
  /** 抽取连续失败退避（瞬态，不持久化：重启后允许首试再退避）：
   *  sessionId → 连败次数与下次可自动重试时间（修闲置兜底×LLM 超时的重试风暴）。 */
  extractFailures = /* @__PURE__ */ new Map();
  pendingFile;
  /** 分族 checkpoint（init 后可用；重建收尾也从这里读活引用）。 */
  states;
  afterRun;
  async init() {
    await this.stores.state.load();
    this.states = {
      chat: this.stores.state.forFamily("chat"),
      work: this.stores.state.forFamily("work")
    };
    if (this.stores.state.didMigrate) {
      this.logger.info("[memory] state.json \u5DF2\u8FC1\u79FB\u4E3A v2 \u5206\u65CF\u683C\u5F0F\uFF08\u65E7\u6570\u636E\u5F52 chat \u6876\uFF09");
      await this.stores.state.save();
    }
    try {
      const { buckets: loaded, warmup } = await loadPending(this.pendingFile, this.logger);
      for (const key of PENDING_MODES) {
        if (loaded[key].length > PENDING_BUCKET_CAP) loaded[key] = loaded[key].slice(-PENDING_BUCKET_CAP);
      }
      this.pending = loaded;
      this.warmup = warmup;
      if (this.pendingCount > 0) {
        this.logger.info(
          `[memory] \u672A\u84B8\u998F\u7F13\u51B2\u5DF2\u6062\u590D ${this.pendingCount} \u6761\uFF08auto=${this.pending.auto.length}/chat=${this.pending.chat.length}/work=${this.pending.work.length}\uFF09\uFF0C${STARTUP_RETRY_DELAY_MS / 1e3}s \u540E\u81EA\u52A8\u8865\u8DD1`
        );
        this.scheduleStartupRetry();
      }
    } catch (err) {
      this.logger.warn(`[memory] \u672A\u84B8\u998F\u7F13\u51B2\u6062\u590D\u5931\u8D25\uFF08\u7A7A\u6876\u8D77\u6B65\uFF09: ${errDetail(err)}`);
    }
  }
  /** 启动补跑：对每个非空桶的每个会话切片入队一次蒸馏尝试（受 live 开关与
   *  生效阈值约束；不足阈值的消息等用户继续或闲置兜底，失败不无限重试）。 */
  scheduleStartupRetry() {
    const modes = PENDING_MODES.filter((m) => this.pending[m].length > 0);
    this.ctx.effect(() => {
      const timer = setTimeout(() => {
        for (const mode of modes) {
          for (const g of groupPendingBySession(this.pending[mode])) {
            this.enqueue(g.sessionId, [], mode);
          }
        }
      }, STARTUP_RETRY_DELAY_MS);
      return () => clearTimeout(timer);
    });
  }
  /** L1 抽取待重试的消息条数（状态面板用）。 */
  get pendingCount() {
    return this.pending.auto.length + this.pending.chat.length + this.pending.work.length;
  }
  /**
   * 会话级蒸馏视图（session-stats 端点数据源；纯内存读，零 I/O）。
   * pendingSlice = 当前档位桶中该会话的攒批切片条数（threshold 为生效阈值，含 warmup 爬坡）；
   * parkedSlices = 其余档位桶中的残留切片（换档遗留 / off 档挂起——ADR-0003 挂起语义）。
   */
  sessionView(sessionId, mode) {
    const count = (bucket) => bucket.reduce((n, m) => m.sessionId === sessionId ? n + 1 : n, 0);
    const view = {
      pendingSlice: 0,
      parkedSlices: 0,
      threshold: null,
      producedRecords: 0,
      lastDistillAt: null
    };
    const prod = this.sessionProduced.get(sessionId);
    if (prod) {
      view.producedRecords = prod.count;
      view.lastDistillAt = prod.lastAt;
    }
    const own = PENDING_MODES.includes(mode) ? mode : null;
    if (own) {
      view.pendingSlice = count(this.pending[own]);
      view.threshold = effectiveExtractThreshold(this.warmup[own], this.cfg.extract?.minMessages ?? 0);
    }
    for (const m of PENDING_MODES) {
      if (m !== own) view.parkedSlices += count(this.pending[m]);
    }
    return view;
  }
  /** 会话产出记账（切片成功消费时调用；LRU 淘汰最久未蒸馏会话防 Map 无界增长）。 */
  noteSessionDistill(sessionId, produced) {
    const now = Date.now();
    const cur = this.sessionProduced.get(sessionId);
    if (cur) {
      cur.count += produced;
      cur.lastAt = now;
    } else {
      this.sessionProduced.set(sessionId, { count: produced, lastAt: now });
    }
    if (this.sessionProduced.size > SESSION_PRODUCED_CAP) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [sid, v] of this.sessionProduced) {
        if (v.lastAt < oldestAt) {
          oldestAt = v.lastAt;
          oldestKey = sid;
        }
      }
      if (oldestKey) this.sessionProduced.delete(oldestKey);
    }
  }
  /** 管线跑完一轮后的回调（用于召回缓存失效）。 */
  setAfterRun(fn) {
    this.afterRun = fn;
  }
  /** 一轮对话结束后入队（L0 落盘由 capture 在 turn/end 即时完成，不排蒸馏队列）。 */
  enqueue(sessionId, messages, mode, opts) {
    this.pushTask({ kind: "live", run: () => this.runTurn(sessionId, messages, mode, opts) });
  }
  /** 重建任务入队（低优先级：让位于正常轮次；由 RebuildController 分块驱动）。 */
  enqueueRebuildTask(run) {
    this.pushTask({ kind: "rebuild", run });
  }
  /** 重建蒸馏轮：统一 auto 档，全量强制蒸馏（不受阈值约束——历史小会话也必须出记忆）、
   *  不受缓冲 200 上限（历史会话全量入桶，由 char 预算分块）。 */
  runRebuildTurn(sessionId, messages) {
    return this.runTurn(sessionId, messages, "auto", { noBufferCap: true, force: true });
  }
  /** 停止取新任务（插件 dispose 序调用；进行中任务照常跑完但不 await——LLM 慢调用不拖住宿主卸载）。 */
  stop() {
    this.stopped = true;
  }
  /** 启动闲置兜底定时器（index.ts 装配；idleSeconds=0 关闭）。 */
  startIdleTimer() {
    const idleMs = (this.cfg.extract.idleSeconds ?? 0) * 1e3;
    if (!(idleMs > 0)) return;
    this.ctx.effect(() => {
      const timer = setInterval(() => this.flushIdleSlices(Date.now(), idleMs), IDLE_TICK_MS);
      return () => clearInterval(timer);
    });
  }
  /** 闲置扫描：静默达标且有切片的会话按捕获档位落袋（off 档会话挂起跳过）。 */
  flushIdleSlices(now, idleMs) {
    if (this.stopped) return;
    const liveNow = this.live.get();
    if (!(liveNow.enabled && liveNow.distill)) return;
    const infos = /* @__PURE__ */ new Map();
    for (const mode of PENDING_MODES) {
      for (const m of this.pending[mode]) {
        const info = infos.get(m.sessionId) ?? { sessionId: m.sessionId, count: 0, lastMessageAt: 0 };
        info.count++;
        info.lastMessageAt = Math.max(info.lastMessageAt, m.timestamp);
        infos.set(m.sessionId, info);
      }
    }
    if (infos.size === 0) return;
    const targets = idleSessionsToFlush(
      [...infos.values()],
      this.lastActivity,
      now,
      idleMs,
      (sid) => this.modes?.get(sid) === "off"
    ).filter((sid) => !this.inExtractBackoff(sid, now));
    for (const sid of targets) {
      this.logger.info(`[memory] \u95F2\u7F6E\u515C\u5E95\uFF1A\u4F1A\u8BDD ${sid} \u9759\u9ED8\u8FBE\u6807\uFF0C\u672A\u84B8\u998F\u5207\u7247\u843D\u888B`);
      this.enqueueSessionSlices(sid);
    }
  }
  /** 把某会话在各桶中的切片按捕获档位逐个入队强制蒸馏（闲置兜底 / 档位切换共用）。 */
  enqueueSessionSlices(sessionId) {
    for (const mode of PENDING_MODES) {
      if (this.pending[mode].some((m) => m.sessionId === sessionId)) {
        this.enqueue(sessionId, [], mode, { force: true });
      }
    }
  }
  /**
   * 档位切换同步（session-modes 的 set() 回调，ADR-0003）：
   * 非 off 间切换 → 该会话切片立即按捕获档位蒸馏（新档位从空切片起步）；
   * 切到 off → 挂起（切片留存，闲置扫描跳过）；从 off 切回 → 挂起片按捕获档位落袋。
   */
  onModeChange(sessionId, oldMode, newMode) {
    const action = modeSwitchAction(oldMode, newMode);
    if (action === "none") return;
    if (action === "park") {
      this.logger.info(`[memory] \u6863\u4F4D\u5207\u6362 ${oldMode}\u2192off\uFF1A\u4F1A\u8BDD ${sessionId} \u672A\u84B8\u998F\u5207\u7247\u6302\u8D77`);
      return;
    }
    this.logger.info(`[memory] \u6863\u4F4D\u5207\u6362 ${oldMode}\u2192${newMode}\uFF08${action}\uFF09\uFF1A\u4F1A\u8BDD ${sessionId} \u5207\u7247\u6309\u6355\u83B7\u6863\u4F4D\u843D\u888B`);
    this.enqueueSessionSlices(sessionId);
  }
  pushTask(task) {
    if (this.stopped) return;
    this.tasks.push(task);
    void this.drain();
  }
  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.tasks.length > 0) {
        const [task] = this.tasks.splice(pickNextTaskIndex(this.tasks), 1);
        try {
          await task.run();
        } catch (err) {
          this.logger.warn(`[memory] \u7BA1\u7EBF\u5931\u8D25\uFF08\u5DF2\u515C\u5E95\uFF09: ${errDetail(err)}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }
  /** 该会话是否处于抽取退避窗口内。 */
  inExtractBackoff(sessionId, now = Date.now()) {
    const f = this.extractFailures.get(sessionId);
    return !!f && now < f.nextAt;
  }
  /** 缓冲落盘（每次蒸馏尝试后调用；失败只告警不阻断管线）。
   *  非重建轮持久化前按桶截断到上限：重建取消后的大桶不至于在后续每次
   *  蒸馏尝试时反复整量序列化落盘（多 MB 级 IO）；重建轮豁免维持。 */
  async persistPending(noBufferCap = false) {
    try {
      if (!noBufferCap) {
        for (const key of PENDING_MODES) {
          const bucket = this.pending[key];
          if (bucket.length > PENDING_BUCKET_CAP) this.pending[key] = bucket.slice(-PENDING_BUCKET_CAP);
        }
      }
      await savePending(this.pendingFile, this.pending, this.warmup);
    } catch (err) {
      this.logger.warn(`[memory] \u672A\u84B8\u998F\u7F13\u51B2\u843D\u76D8\u5931\u8D25: ${errDetail(err)}`);
    }
  }
  async runTurn(sessionId, messages, mode, opts) {
    const turnStart = Date.now();
    this.logger.info(
      `[memory] \u84B8\u998F\u7BA1\u7EBF\u5F00\u59CB\uFF08session=${sessionId}\uFF0Cmode=${mode}\uFF0C\u672C\u8F6E ${messages.length} \u6761\u6D88\u606F\uFF0C\u5F85\u91CD\u8BD5 ${this.pendingCount} \u6761\uFF09`
    );
    const cfg = effectiveCfg(this.cfg, this.live);
    let newRecords = [];
    const liveNow = this.live.get();
    const distillOn = liveNow.enabled && liveNow.distill;
    if (cfg.extract.enabled && distillOn) {
      const bucket = this.pending[mode];
      bucket.push(...messages.map((m) => ({ ...m, sessionId })));
      if (!opts?.noBufferCap && bucket.length > PENDING_BUCKET_CAP) {
        bucket.splice(0, bucket.length - PENDING_BUCKET_CAP);
      }
      if (messages.length > 0) this.lastActivity.set(sessionId, Date.now());
      const effective = effectiveExtractThreshold(this.warmup[mode], cfg.extract.minMessages);
      const sliceLen = bucket.reduce((n, m) => m.sessionId === sessionId ? n + 1 : n, 0);
      const backedOff = !opts?.noBufferCap && this.inExtractBackoff(sessionId);
      if ((opts?.force || sliceLen >= effective) && !backedOff) {
        newRecords = await this.extractSessionSlice(sessionId, mode, cfg, effective, opts);
      } else {
        this.logger.debug?.(
          backedOff ? `[memory] \u84B8\u998F\u9000\u907F\u4E2D\uFF0C\u672C\u8F6E\u8DF3\u8FC7\u62BD\u53D6\uFF08session=${sessionId}\uFF0Cmode=${mode}\uFF09` : `[memory] \u4F1A\u8BDD\u5207\u7247\u6512\u6279\u4E2D\uFF08session=${sessionId}\uFF0Cmode=${mode}\uFF0C${sliceLen}/${effective}\uFF09`
        );
        await this.persistPending(opts?.noBufferCap);
      }
    }
    if (cfg.l2.enabled && distillOn) {
      for (const family of ["chat", "work"]) {
        const familyRecords = newRecords.filter((r) => (r.family ?? "chat") === family);
        if (familyRecords.length === 0) continue;
        const fstate = this.states[family];
        if (fstate.newMemoriesSinceL2 >= cfg.l2.minNewMemories) {
          try {
            const t = Date.now();
            const result = await runSceneConsolidation(this.ctx, cfg, this.stores.scenes[family], familyRecords, this.logger, family);
            fstate.lastL2At = Date.now();
            fstate.newMemoriesSinceL2 = 0;
            if (result.personaRequestedReason) fstate.personaRequestedReason = result.personaRequestedReason;
            this.logger.info(`[memory] L2 \u9636\u6BB5\u5B8C\u6210\uFF08family=${family}\uFF0C${Date.now() - t}ms\uFF09`);
          } catch (err) {
            this.logger.warn(`[memory] L2 \u573A\u666F\u6574\u5408\u5931\u8D25\uFF08family=${family}\uFF09: ${errDetail(err)}`);
          }
        } else {
          this.logger.debug?.(
            `[memory] L2 \u8DF3\u8FC7\uFF08family=${family}\uFF0C\u672C\u65CF\u65B0\u589E ${familyRecords.length} \u6761\uFF0C\u7D2F\u8BA1\u672A\u6574\u5408 ${fstate.newMemoriesSinceL2}/${cfg.l2.minNewMemories}\uFF09`
          );
        }
      }
    }
    if (cfg.l3.enabled && distillOn) {
      for (const family of ["chat", "work"]) {
        try {
          await runPersona(this.ctx, cfg, this.stores.scenes[family], this.stores.persona[family], this.states[family], this.logger, family);
        } catch (err) {
          this.logger.warn(`[memory] L3 \u753B\u50CF\u84B8\u998F\u5931\u8D25\uFF08family=${family}\uFF09: ${errDetail(err)}`);
        }
      }
    }
    try {
      await this.stores.state.save();
    } catch (err) {
      this.logger.warn(`[memory] \u72B6\u6001\u4FDD\u5B58\u5931\u8D25: ${errDetail(err)}`);
    }
    this.logger.info(`[memory] \u84B8\u998F\u7BA1\u7EBF\u7ED3\u675F\uFF08\u672C\u8F6E\u65B0\u589E ${newRecords.length} \u6761\uFF0C\u603B\u8017\u65F6 ${Date.now() - turnStart}ms\uFF09`);
    this.afterRun?.();
    return newRecords.length;
  }
  /**
   * 抽取并消费一个会话切片：成功才把切片移出桶并推进爬坡阈值；失败保留切片待重试。
   * 调用方已保证切片达到生效阈值（或 force）。背景参考按会话从 L0 现查并剔除切片
   * 自身（ADR-0003：会话间互不污染、重启不丢背景）。
   */
  async extractSessionSlice(sessionId, mode, cfg, effectiveThreshold, opts) {
    const bucket = this.pending[mode];
    const slice = bucket.filter((m) => m.sessionId === sessionId);
    if (slice.length === 0) return [];
    const rest = bucket.filter((m) => m.sessionId !== sessionId);
    try {
      const background = this.stores.l0 ? pickSessionBackground(
        await this.stores.l0.recentBySession(sessionId, cfg.extract.backgroundMessages + slice.length),
        new Set(slice.map((m) => m.id)),
        cfg.extract.backgroundMessages
      ) : [];
      const t = Date.now();
      const result = await runExtraction(this.ctx, cfg, this.stores.l1, this.states, slice, background, this.logger, mode);
      if (!result.skipped) {
        this.pending[mode] = rest;
        if (!opts?.force) this.warmup[mode] = advanceWarmupThreshold(this.warmup[mode], cfg.extract.minMessages);
        this.noteSessionDistill(sessionId, result.newRecords.length);
        this.extractFailures.delete(sessionId);
      }
      this.logger.info(
        `[memory] L1 \u9636\u6BB5\u5B8C\u6210\uFF08session=${sessionId}\uFF0Cmode=${mode}\uFF0C\u5207\u7247 ${slice.length} \u6761\uFF0C\u80CC\u666F ${background.length} \u6761\uFF0C\u9608\u503C ${effectiveThreshold}\uFF0C${Date.now() - t}ms\uFF09`
      );
      await this.persistPending(opts?.noBufferCap);
      try {
        await this.stores.state.save();
      } catch (err) {
        this.logger.warn(`[memory] \u72B6\u6001\u4FDD\u5B58\u5931\u8D25: ${errDetail(err)}`);
      }
      return result.newRecords;
    } catch (err) {
      this.logger.warn(`[memory] L1 \u62BD\u53D6\u5931\u8D25\uFF08session=${sessionId}\uFF0Cmode=${mode}\uFF0C\u5207\u7247 ${slice.length} \u6761\uFF09: ${errDetail(err)}`);
      const streak = (this.extractFailures.get(sessionId)?.streak ?? 0) + 1;
      const delayMs = extractionBackoffMs(streak);
      this.extractFailures.set(sessionId, { streak, nextAt: Date.now() + delayMs });
      this.logger.info(
        `[memory] \u84B8\u998F\u8FDE\u7EED\u5931\u8D25 ${streak} \u6B21\uFF0C${Math.round(delayMs / 1e3)}s \u5185\u6682\u505C\u8BE5\u4F1A\u8BDD\u7684\u81EA\u52A8\u91CD\u8BD5`
      );
      await this.persistPending(opts?.noBufferCap).catch(() => {
      });
      return [];
    }
  }
}
export {
  MemoryRunner,
  effectiveCfg,
  pickNextTaskIndex
};
