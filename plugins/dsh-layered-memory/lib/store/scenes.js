import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicWriteText, ensureDir, readTextIfExists } from "./io.js";
import { NAV_HEADER } from "./persona.js";
const META_START = "-----META-START-----";
const META_END = "-----META-END-----";
const DELETED_MARKER = "[DELETED]";
class SceneStore {
  constructor(dataDir, family, logger) {
    this.logger = logger;
    this.family = family;
    this.dir = path.join(dataDir, "scenes", family);
  }
  dir;
  family;
  async init() {
    await ensureDir(this.dir);
    await this.migrateLegacyLayout();
  }
  /** 旧布局迁移：scenes/ 根下的 .md 移入本族目录。仅 chat 族执行（历史数据归属 chat）。 */
  async migrateLegacyLayout() {
    if (this.family !== "chat") return;
    const legacyDir = path.dirname(this.dir);
    let files;
    try {
      files = await fs.readdir(legacyDir);
    } catch {
      return;
    }
    let moved = 0;
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const from = path.join(legacyDir, f);
      const to = path.join(this.dir, f);
      try {
        await fs.rename(from, to);
        moved++;
      } catch {
      }
    }
    if (moved > 0) this.logger?.info(`[memory] \u573A\u666F\u76EE\u5F55\u8FC1\u79FB\uFF1A${moved} \u4E2A\u6587\u4EF6 scenes/ \u2192 scenes/chat/`);
  }
  listFiles() {
    return fs.readdir(this.dir).catch(() => []);
  }
  /** 列出场景摘要（解析 META 块）。 */
  async list() {
    const files = await this.listFiles();
    const out = [];
    for (const f of files.sort()) {
      if (!f.endsWith(".md")) continue;
      const content = await readTextIfExists(path.join(this.dir, f));
      if (!content || content.trim() === DELETED_MARKER) continue;
      out.push(parseMeta(content, f));
    }
    return out;
  }
  async read(name) {
    const safe = sanitizeFilename(name);
    if (!safe) return void 0;
    return readTextIfExists(path.join(this.dir, safe));
  }
  /**
   * 写入/重写场景文件。content 为 [DELETED] 时删除该文件（LLM 的 delete 操作）。
   * 文件名自动归一化（空格→短横线、剔除非法字符），非法则抛错。
   */
  async write(name, content) {
    const safe = sanitizeFilename(name);
    if (!safe) throw new Error(`\u975E\u6CD5\u7684\u573A\u666F\u6587\u4EF6\u540D: ${name}`);
    const file = path.join(this.dir, safe);
    if (content.trim() === DELETED_MARKER) {
      await fs.unlink(file).catch(() => void 0);
      return safe;
    }
    await atomicWriteText(file, content);
    return safe;
  }
  /** 场景导航索引（召回注入用）。 */
  async navigation() {
    const scenes = await this.list();
    if (scenes.length === 0) return "";
    const lines = [
      NAV_HEADER,
      "*\u4EE5\u4E0B\u662F\u5F53\u524D\u573A\u666F\u8BB0\u5FC6\u7D22\u5F15\uFF0C\u53EF\u4F7F\u7528 memory_read_scene \u8BFB\u53D6\u8BE6\u7EC6\u5185\u5BB9\u3002*",
      ""
    ];
    for (const s of scenes) {
      lines.push(`- \`${s.path}\` \u2014 ${s.summary || "(\u65E0\u6458\u8981)"}`);
    }
    return lines.join("\n");
  }
}
function parseMeta(content, name) {
  const s = { path: name, created: "", updated: "", summary: "", heat: 0 };
  const start = content.indexOf(META_START);
  const end = content.indexOf(META_END);
  if (start !== -1 && end !== -1) {
    const meta = content.slice(start + META_START.length, end);
    for (const line of meta.split("\n")) {
      const m = /^\s*([a-zA-Z_]+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (key === "created") s.created = value;
      else if (key === "updated") s.updated = value;
      else if (key === "summary") s.summary = value;
      else if (key === "heat") s.heat = Number.parseInt(value, 10) || 0;
    }
  }
  return s;
}
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function sanitizeFilename(name) {
  let n = name.trim();
  if (!n.toLowerCase().endsWith(".md")) n = `${n}.md`;
  n = n.replace(/[^\w\u3400-\u9fff\uf900-\ufaff.\-_]/g, "-").replace(/-{2,}/g, "-").replace(/-+\.md$/i, ".md").replace(/^-+|-+$/g, "");
  let stem = n.slice(0, -3);
  if (stem.length > 120) stem = stem.slice(0, 120).replace(/[-._]+$/, "");
  if (RESERVED_NAME_RE.test(stem)) stem = `_${stem}`;
  n = `${stem}.md`;
  if (!n || !/^[\w\u3400-\u9fff\uf900-\ufaff.\-_]+\.md$/i.test(n)) return "";
  return n;
}
export {
  META_END,
  META_START,
  SceneStore,
  sanitizeFilename
};
