# DeepSeek Harness Desktop —— 打包 · 发布 · 安装 完整教程

> 这份文档同时存在于两处，内容一致：
> - 发布目录：`/Volumes/编程工具/发布包/打包发布教程.md`（本文件）
> - 代码仓库：`/Volumes/编程工具/deepseek-harness-desktop/docs/RELEASE-PACKAGING.md`
>
> 项目路径：`/Volumes/编程工具/deepseek-harness-desktop`
> 平台：macOS · Apple Silicon（arm64）

---

## 0. 给未来 Agent 的铁律（先读这条）

1. **所有打包产物必须放进 `/Volumes/编程工具/发布包/`**，不要留在 `src-tauri/target/` 或 `dist/` 就算完事。
2. **打包之前必须先删除旧的安装包**：进 `/Volumes/编程工具/发布包/`，删掉所有旧的 `DeepSeek-Harness-Desktop-*`（dmg / app.zip / sha256），**只留最新一版**。旧版不归档、不保留，避免发布目录堆积多版本造成混淆。
3. 命名规范：`DeepSeek-Harness-Desktop-<版本>-macos-<arch>.<dmg|app.zip>`，每个产物**都要附一个同名 `.sha256`**。
   - `<版本>` 取 `package.json` 里的 `version`；`<arch>` 取 `arm64`（Apple Silicon）。
   - 例：`DeepSeek-Harness-Desktop-1.0.1-macos-arm64.dmg` + `DeepSeek-Harness-Desktop-1.0.1-macos-arm64.dmg.sha256`
4. **打包必须用「自包含（静态链接）的官方 Node」**，不能用 Homebrew 的 node。理由见第 1 节 —— 这是最容易踩的坑。
5. 装到 `/Applications` 前先退出正在运行的旧实例（见第 6 节）。应用数据不在 app 里，替换 bundle 不会丢数据。
6. **权限反复弹窗**：不要用裸 ad-hoc（每次 cdhash 都变，TCC 开关看着开着其实对不上）。打包脚本会用登录钥匙串里的本地证书 `DeepSeek Harness Local` 重签，并把 designated requirement 钉成 `identifier "ai.deepseek.harness.desktop"`。TCC 按 bundle id 认应用，重装不再反复要辅助功能 / 屏幕录制。

---

## 1. 前置条件与环境（⚠ 关键在 Node）

- **Xcode Command Line Tools**（提供 `codesign`、`hdiutil` 等）。
- **Rust / cargo**：在 `~/.cargo/bin`（本机验证过 cargo 1.94）。Tauri 用它编译原生外壳。
- **pnpm 11.x**：仓库根与 `harness/` 子仓的依赖都要先装好（`pnpm install`）。
- **Node ≥ 22.19 或 ≥ 24，且必须是「自包含」的二进制**。

### ⚠ 为什么 Node 必须自包含

打包脚本 `scripts/build-release.mjs` 的 `copyNodeRuntime()` 会把**当前解释器**（`process.execPath`）这个 node 可执行文件**直接拷进 app** 当运行时。
- Homebrew 的 `/opt/homebrew/bin/node` 是**动态链接**的（依赖 `@rpath/libnode.147.dylib`、`/opt/homebrew/opt/...` 一堆动态库）。只拷可执行文件、不带这些 dylib，嵌进去的 node 一跑就：
  ```
  dyld: Library not loaded: @rpath/libnode.147.dylib
  ```
  → 打包在 **smoke 冒烟步骤直接失败**；就算跳过冒烟，打出来的 app 也起不来。

### 怎么判断当前 node 能不能用

```bash
otool -L "$(which node)"
```
输出里若出现 `@rpath/libnode.*.dylib` 或 `/opt/homebrew/...` → **不能用**（动态版）。
只出现 `/System/...` 与 `/usr/lib/...` 系统框架 → 可用（自包含）。

### 去哪找一个自包含的 Node

任选其一（都要 ≥22.19 或 ≥24）：
1. **已安装的 app 里就自带一个**（最省事）：
   `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/node`
2. 官方 [nodejs.org](https://nodejs.org) 的 macOS **arm64** pkg/tar 安装的 node。
3. `nvm` / `fnm` 安装的官方二进制（这些是自包含的，Homebrew 才不是）。

---

## 2. 一键打包命令（推荐，已含全部绕过）

```bash
cd /Volumes/编程工具/deepseek-harness-desktop && \
npm_config_verify_deps_before_run=false npm_config_confirm_modules_purge=false DSH_TELEMETRY_DISABLED=1 \
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/node" scripts/build-release.mjs
```

三个要点：
- 开头那个 **node 路径 = 自包含 node**（见第 1 节，这里借用已装 app 里那个）。用它当解释器，`copyNodeRuntime()` 嵌进去的就是它。
- `npm_config_verify_deps_before_run=false` + `npm_config_confirm_modules_purge=false`：关掉 pnpm「跑脚本前的依赖自愈」。lockfile 含 linux-only 原生依赖，mac 上被判「缺失」，pnpm 想清 `node_modules`，但在非 TTY（脚本/Agent）里会 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 直接失败。依赖其实是齐的，关掉安全。
- `DSH_TELEMETRY_DISABLED=1`：冒烟时不发遥测。

> 若你在**交互式终端**里手动跑，且 PATH 上的 `node` 已经是自包含官方版，可以直接 `pnpm run build`；但脚本/Agent 场景请用上面这条完整命令，最稳。

### 只想快速看效果、不出安装包

```bash
cd /Volumes/编程工具/deepseek-harness-desktop && pnpm run dev:desktop
```
这会以 dev 模式起应用（加载 `harness/apps/cli/lib/bin.js`，运行时从各包 `lib/` 加载），改完源码重建 lib 即可看到效果，不必走完整打包。

---

## 3. 打包脚本做了什么（`build-release.mjs` 流程）

| 步骤 | 作用 |
|---|---|
| `prepareHarness` | 构建 vendored harness（tsc 出各包 `lib/types/`，tsdown 打成各包 `lib/index.js`，web 前端）。会按源码 mtime 决定是否重建。 |
| `prepareBundledPlugins` | 构建捆绑插件（含 `dsh-model-capability`、`dsh-attachment`、`dsh-desktop-manager` 等）。 |
| `deployCli` | `pnpm deploy --prod` 把 CLI 运行时闭包铺到 `release-runtime/harness/`。 |
| `stageBundledPlugins` / `materializeHarnessClosure` | 组装**可移植**运行时：解掉符号链接、校验闭包完整（约 519 个包）。 |
| `copyNodeRuntime` | 把当前 node 嵌成 `release-runtime/node`（← 要求自包含 node 的根源）。 |
| `smokeRuntime` | 用嵌入的 node 起一次 `bin.js web` 冒烟，校验能返回 HTML 与各插件包。 |
| `buildTauri` | `pnpm tauri build --bundles app,dmg`：编译 Rust → 打 `.app` → ad-hoc 签名（`codesign -s -`）→ 打 `.dmg`。 |
| `publishPlatformBundles` | 把 `.dmg` 复制到 `dist/`。 |

产物落点：
- `.app`：`src-tauri/target/release/bundle/macos/DeepSeek Harness.app`
- `.dmg`（成功时）：`src-tauri/target/release/bundle/dmg/DeepSeek Harness_<版本>_aarch64.dmg`，脚本再复制到 `dist/`。

---

## 4. 已知问题：`.dmg` 最后一步偶发失败（可绕过）

- **现象**：
  ```
  hdiutil: couldn't unmount "diskN" - 资源忙
  failed to bundle project: error running bundle_dmg.sh
  ```
  tauri 打 dmg 用 Finder + AppleScript 做卷样式，最后卸载临时卷时常被 Spotlight / `fseventsd` / 正在运行的旧 app 占用而失败。
- **重点**：`.app` 在这一步**之前**就已完整生成并签名，dmg 失败**不影响 app**。
- **自己稳妥出 dmg（不依赖 Finder）**：

```bash
APP="/Volumes/编程工具/deepseek-harness-desktop/src-tauri/target/release/bundle/macos/DeepSeek Harness.app"
OUT="/Volumes/编程工具/发布包/DeepSeek-Harness-Desktop-1.0.1-macos-arm64.dmg"
STAGE=$(mktemp -d)
ditto "$APP" "$STAGE/DeepSeek Harness.app"
ln -s /Applications "$STAGE/Applications"          # 拖拽安装用的软链
rm -f "$OUT"
hdiutil create -volname "DeepSeek Harness" -srcfolder "$STAGE" -ov -format UDBZ "$OUT"
rm -rf "$STAGE"
hdiutil verify "$OUT"                              # 校验完整性（不挂载）
```

> ⚠ **压缩格式别用 UDZO**：同样内容（app 未压缩约 497M，光内嵌 Node 就 136M），
> `UDZO`(zlib) 会打到 ~222M，`UDBZ`(bzip2) 只 ~96M，`ULMO`(LZMA) 最小 ~79M（需 macOS ≥10.15，arm64 应用没问题）。
> 默认用 **UDBZ**；已有 dmg 想换格式：`hdiutil convert 旧.dmg -format UDBZ -o 新.dmg`。

- 若有临时卷卸载不掉残留：`mount | grep dmg.` 看设备名，再 `hdiutil detach /dev/diskN -force`。

---

## 5. 把产物放进发布包（铁律落地）

```bash
REL="/Volumes/编程工具/发布包"
APP="/Volumes/编程工具/deepseek-harness-desktop/src-tauri/target/release/bundle/macos/DeepSeek Harness.app"
VER="1.0.1"; ARCH="arm64"                          # VER 取 package.json 的 version
STEM="DeepSeek-Harness-Desktop-${VER}-macos-${ARCH}"
mkdir -p "$REL"

# 0) ⚠ 先删旧版（铁律第 2 条）：发布目录只留最新一版
rm -f "$REL"/DeepSeek-Harness-Desktop-*.dmg \
      "$REL"/DeepSeek-Harness-Desktop-*.zip \
      "$REL"/DeepSeek-Harness-Desktop-*.sha256

# 1) dmg：见第 4 节（输出到 "$REL/${STEM}.dmg"）
# 2) 便携 zip 的 .app（保签名/属性）
ditto -c -k --keepParent "$APP" "$REL/${STEM}-app.zip"
# 3) 校验和（每个产物一份）
cd "$REL"
shasum -a 256 "${STEM}.dmg"     > "${STEM}.dmg.sha256"
shasum -a 256 "${STEM}-app.zip" > "${STEM}-app.zip.sha256"
ls -lh "$REL"
```

发布包目录里每个版本应有：`.dmg` + `.dmg.sha256` + `-app.zip` + `-app.zip.sha256`。

---

## 6. 安装（替换 `/Applications`）

1. 退出正在运行的旧实例：
   ```bash
   osascript -e 'quit app "DeepSeek Harness"' 2>/dev/null || pkill -f "DeepSeek Harness.app/Contents/MacOS"
   ```
2. **分步换位安装**（原子、可回退，避免半拷贝）：
   ```bash
   NEW="/Volumes/编程工具/deepseek-harness-desktop/src-tauri/target/release/bundle/macos/DeepSeek Harness.app"
   DEST="/Applications/DeepSeek Harness.app"
   ditto "$NEW" "/Applications/.DSH.new"
   rm -rf "$DEST"
   mv "/Applications/.DSH.new" "$DEST"
   open "$DEST"
   ```
   —— 或者直接双击发布包里的 `.dmg`，把 app 拖进 Applications。
3. 说明：`/Applications/DeepSeek Harness.app` 归属应为当前用户（`admin:admin`），可免 sudo 替换。应用数据（会话/设置）在 `~/Library/Application Support/` 或 `DSH_HOME`，**替换 bundle 不动数据**。

---

## 7. 验证（打完/装完都该做）

```bash
APP="/Applications/DeepSeek Harness.app"   # 或 target 里那个

# 结构与签名（本地稳定证书 + identifier DR，不要 --deep）
codesign --verify --strict "$APP" && echo "codesign OK"
codesign -d -r- "$APP" 2>&1 | grep 'identifier "ai.deepseek.harness.desktop"'

# 内嵌 node 必须自包含（只应有系统框架）
otool -L "$APP/Contents/Resources/runtime/node" | grep -c "libnode\|homebrew"   # 期望 0
# 内嵌 node 必须带 JIT entitlements（否则别人机器上 V8 CodeRange 直接 FatalOOM）
codesign -d --entitlements :- "$APP/Contents/Resources/runtime/node" 2>/dev/null \
  | grep -q 'allow-jit' && echo "node jit OK"
# 内嵌 node 必须能单独起 Isolate（这条在别人机器上比 codesign --verify 更能拦住 CodeRange OOM）
"$APP/Contents/Resources/runtime/node" -e "console.log('node ok', process.version)"

# 「所有模型可发图」这次修复是否在包里
grep -c withImageInput \
  "$APP/Contents/Resources/runtime/harness/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js"  # 期望 >0
```

启动后进程应有两个：主进程 `.../MacOS/deepseek-harness-desktop` + 后端 `.../runtime/node .../harness/lib/bin.js web ...`。
功能验证：任意模型贴图发送，不再弹「当前模型不支持图片」。

---

## 8. 故障速查表

| 报错 / 现象 | 原因 | 处置 |
|---|---|---|
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | pnpm 非 TTY 下想清 `node_modules` | 加 `npm_config_verify_deps_before_run=false npm_config_confirm_modules_purge=false`（第 2 节） |
| `dyld: Library not loaded: @rpath/libnode.*.dylib`（smoke 失败） | 用了 Homebrew 动态版 node | 用自包含 node 跑打包（第 1 节） |
| dmg `couldn't unmount ... 资源忙` | Finder/Spotlight 占用临时卷 | 用第 4 节的 `hdiutil` 自建 dmg；残留卷 `hdiutil detach /dev/diskN -force` |
| `Node ... is outside Harness's supported range` | node 版本太低 | 换 ≥22.19 或 ≥24 的自包含 node |
| `Fatal process out of memory: Failed to reserve virtual memory for CodeRange` | 内嵌 node 开了 hardened runtime 却没有 JIT entitlements，V8 Isolate 初始化被系统掐掉 | 用带 `allow-jit` 的 entitlements 重签 `Contents/Resources/runtime/node` 和 `.app`（`scripts/macos-stable-sign.sh`） |

---

## 9. 这次改了什么（供追溯）

- **需求**：所有模型都能发送图片，且真正发出去，不再弹「当前模型不支持图片」。
- **根因**：图片能力由 pi-ai 适配器解析出的 `model.input` 决定，默认只有 `['text']`；这个值被**三道准入闸**共同读取（host prompt 闸、切换模型闸、pi-ai stream 闸），少拆一道就会「换个地方再报错」。之前那个 `dsh-model-capability` 插件只改了设置页下拉框的**默认显示**，没真正写进模型能力，所以没生效。
- **修复（单点根治）**：在 pi-ai 物化每个模型 `input` 的唯一汇聚点
  `harness/packages/llm/llm-pi-ai/src/catalog.ts` 加 `withImageInput()`，**强制每个模型的 input 都含 `image`**。三道闸同时放行，序列化器（`context.ts`，把图片转 base64 图块）本就工作 → 端到端真正发出。
- DeepSeek 原生适配器本就通过 OCR 支持图片，无需改。
- **取舍**：真视觉模型正常识图；若某模型上游确实纯文本，会由网关**中途返回错误**（提供方的诚实回答），而不是客户端提前拦截 —— 这是「所有模型都放开」本身必然的代价。
