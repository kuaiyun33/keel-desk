import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicWriteText, readTextIfExists } from "./io.js";
const NAV_HEADER = "## \u{1F5FA}\uFE0F Scene Navigation";
class PersonaStore {
  constructor(dataDir, family, logger) {
    this.logger = logger;
    this.family = family;
    this.file = path.join(dataDir, `persona-${family}.md`);
  }
  file;
  family;
  /** 旧布局迁移：persona.md → persona-chat.md（幂等，仅 chat 族执行）。 */
  async init() {
    if (this.family !== "chat") return;
    const dataDir = path.dirname(this.file);
    const legacy = path.join(dataDir, "persona.md");
    try {
      await fs.access(legacy);
      await fs.rename(legacy, this.file);
      this.logger?.info("[memory] \u753B\u50CF\u6587\u4EF6\u8FC1\u79FB\uFF1Apersona.md \u2192 persona-chat.md");
    } catch {
    }
  }
  /** 读取正文（剥离场景导航部分）。 */
  async read() {
    const raw = await readTextIfExists(this.file);
    if (!raw) return void 0;
    return stripSceneNavigation(raw).trim() || void 0;
  }
  /** 文件 mtime（epoch ms；无画像文件 null）——工作台资产活动流的 L3 时间源。 */
  async mtime() {
    try {
      return (await fs.stat(this.file)).mtimeMs;
    } catch {
      return null;
    }
  }
  /** 写入正文（保留已有导航段则拼回尾部）。 */
  async write(body) {
    const raw = await readTextIfExists(this.file);
    const nav = raw ? extractSceneNavigation(raw) : void 0;
    const content = nav ? `${body.trim()}

${nav}
` : `${body.trim()}
`;
    await atomicWriteText(this.file, content);
  }
}
function stripSceneNavigation(content) {
  const idx = content.indexOf(NAV_HEADER);
  if (idx === -1) return content;
  return content.slice(0, idx).trimEnd();
}
function extractSceneNavigation(content) {
  const idx = content.indexOf(NAV_HEADER);
  if (idx === -1) return void 0;
  return content.slice(idx).trim();
}
export {
  NAV_HEADER,
  PersonaStore,
  stripSceneNavigation
};
