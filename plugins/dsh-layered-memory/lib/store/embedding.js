class NoopEmbeddingService {
  getDimensions() {
    return 0;
  }
  getProviderInfo() {
    return { provider: "noop", model: "disabled", dimensions: 0 };
  }
  isReady() {
    return false;
  }
  async embed() {
    return new Float32Array(0);
  }
  async embedBatch(texts) {
    return texts.map(() => new Float32Array(0));
  }
}
class RemoteEmbeddingService {
  opts;
  constructor(opts) {
    this.opts = { maxInputChars: 5e3, timeoutMs: 1e4, ...opts };
  }
  getDimensions() {
    return this.opts.dimensions;
  }
  getProviderInfo() {
    return { provider: "remote", model: this.opts.model, dimensions: this.opts.dimensions };
  }
  isReady() {
    return true;
  }
  async embed(text, callOpts) {
    const [vec] = await this.embedBatch([text], callOpts);
    return vec;
  }
  async embedBatch(texts, callOpts) {
    if (texts.length === 0) return [];
    const input = texts.map((t) => t.slice(0, this.opts.maxInputChars));
    const base = this.opts.baseUrl.replace(/\/+$/, "");
    const timeoutMs = Math.min(this.opts.timeoutMs, callOpts?.timeoutMs ?? this.opts.timeoutMs);
    const res = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`
      },
      body: JSON.stringify({ model: this.opts.model, input }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`embeddings HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const data = json.data ?? [];
    if (data.length !== texts.length) {
      throw new Error(`embeddings \u8FD4\u56DE\u6570\u91CF\u4E0D\u5339\u914D\uFF1A\u671F\u671B ${texts.length}\uFF0C\u5F97\u5230 ${data.length}`);
    }
    const byIndex = /* @__PURE__ */ new Map();
    for (const d of data) byIndex.set(d.index, d.embedding);
    return input.map((_, i) => {
      const raw = byIndex.get(i);
      if (!raw || raw.length !== this.opts.dimensions) {
        throw new Error(`embedding \u7EF4\u5EA6\u4E0D\u5339\u914D\uFF1A\u671F\u671B ${this.opts.dimensions}\uFF0C\u5F97\u5230 ${raw?.length ?? 0}`);
      }
      return sanitizeAndNormalize(raw);
    });
  }
}
function sanitizeAndNormalize(vec) {
  const arr = Array.from(vec).map((v) => Number.isFinite(v) ? v : 0);
  const magnitude = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
  if (magnitude < 1e-10) return new Float32Array(arr);
  return new Float32Array(arr.map((v) => v / magnitude));
}
class EmbedHelper {
  constructor(embed, logger) {
    this.embed = embed;
    this.logger = logger;
  }
  warned = false;
  /** 活切换嵌入源（D4/D5）：换掉底层服务并复位一次性告警（新服务重新获得告警机会）。 */
  setService(svc) {
    this.embed = svc;
    this.warned = false;
  }
  vectorReady() {
    return this.embed.isReady();
  }
  /** 查询向量；失败或空向量返回 undefined（调用方降级 FTS）。
   *  timeoutMs 为内层钳制（仅缩短服务超时），召回路径使用。 */
  async query(text, timeoutMs) {
    try {
      const vec = await this.embed.embed(text, timeoutMs != null ? { timeoutMs } : void 0);
      return vec.length > 0 ? vec : void 0;
    } catch (err) {
      this.warn(`\u67E5\u8BE2\u5411\u91CF\u8BA1\u7B97\u5931\u8D25\uFF0C\u964D\u7EA7 FTS: ${errMsg(err)}`);
      return void 0;
    }
  }
  /** 批量嵌入；服务未就绪或失败时返回全 undefined（不阻断元数据/FTS 写入）。 */
  async batch(texts) {
    if (!this.embed.isReady()) return texts.map(() => void 0);
    try {
      return await this.embed.embedBatch(texts);
    } catch (err) {
      this.warn(`\u6279\u91CF\u5D4C\u5165\u5931\u8D25\uFF0C\u672C\u6279\u6682\u4E0D\u5199\u5411\u91CF\uFF08\u540E\u53F0 backfill \u4F1A\u8865\u9F50\uFF09: ${errMsg(err)}`);
      return texts.map(() => void 0);
    }
  }
  warn(msg) {
    if (this.warned) return;
    this.warned = true;
    this.logger?.warn(`[memory] ${msg}`);
  }
}
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}
export {
  EmbedHelper,
  NoopEmbeddingService,
  RemoteEmbeddingService
};
