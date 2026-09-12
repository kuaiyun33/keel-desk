#!/usr/bin/env node
/** Render official PentAGI assistant+pentester templates into kernel-pentagi.md */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const tmplDir = join(repo, 'vendor/pentagi/backend/pkg/templates/prompts')
const out = join(here, '../src/profiles/kernel-pentagi.md')

const vars = {
  Lang: '中文',
  DockerImage: 'vxcontrol/kali-linux',
  Cwd: '/work',
  ContainerPorts: 'Harness maps host ports via pg_terminal (sandbox=true uses kali image).',
  CurrentTime: '(session clock)',
  ExecutionContext: 'DeepSeek Harness PentAGI seat. Tools are pg_*. Official compose API at https://127.0.0.1:8443 when backend is up.',
  UseAgents: true,
  GraphitiEnabled: true,
  FlowManagerEnabled: true,
  UserFiles: '',
  TerminalToolName: 'pg_terminal',
  FileToolName: 'pg_file',
  BrowserToolName: 'pg_browser',
  WebSearchToolName: 'pg_web_search',
  SearchToolName: 'pg_search',
  PentesterToolName: 'pg_pentester',
  CoderToolName: 'pg_coder',
  AdviceToolName: 'pg_advice',
  MemoristToolName: 'pg_memorist',
  MaintenanceToolName: 'pg_maintenance',
  SearchInMemoryToolName: 'pg_search_in_memory',
  SearchGuideToolName: 'pg_search_guide',
  SearchAnswerToolName: 'pg_search_answer',
  SearchCodeToolName: 'pg_search_code',
  StoreGuideToolName: 'pg_store_guide',
  GraphitiSearchToolName: 'pg_graphiti_search',
  HackResultToolName: 'pg_report_result',
  GetFlowStatusToolName: 'pg_flow_status',
  StopFlowToolName: 'pg_flow_stop',
  SubmitFlowInputToolName: 'pg_flow_input',
  PatchFlowSubtasksToolName: 'pg_subtask_patch',
  WaitFlowCompletionToolName: 'pg_flow_wait',
  SummarizationToolName: 'summarize',
  SummarizedContentPrefix: '[SUMMARIZED]',
}

function truthy(name) {
  const v = vars[name]
  if (v === true) return true
  if (v === false || v === '' || v == null) return false
  return Boolean(v)
}

function lookup(inner) {
  const key = inner.replace(/^\./, '').trim()
  return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : ''
}

function tokenize(src) {
  const re = /\{\{-?\s*(.*?)\s*-?\}\}/gs
  const tokens = []
  let last = 0
  let m
  while ((m = re.exec(src))) {
    if (m.index > last) tokens.push({ t: 'text', v: src.slice(last, m.index) })
    tokens.push({ t: 'tag', v: m[1].trim() })
    last = m.index + m[0].length
  }
  if (last < src.length) tokens.push({ t: 'text', v: src.slice(last) })
  return tokens
}

function parse(tokens) {
  let i = 0
  function block(until) {
    const nodes = []
    while (i < tokens.length) {
      const tok = tokens[i]
      if (tok.t === 'text') {
        nodes.push({ kind: 'text', v: tok.v })
        i++
        continue
      }
      const v = tok.v
      if (until && (v === until || (until === 'end' && (v === 'end' || v.startsWith('else'))))) break
      if (v.startsWith('if ')) {
        i++
        const key = v.replace(/^if\s+\.?/, '').trim()
        const thenN = block('end')
        let elseN = []
        if (i < tokens.length && tokens[i].t === 'tag' && tokens[i].v.startsWith('else')) {
          i++
          elseN = block('end')
        }
        if (i < tokens.length && tokens[i].t === 'tag' && tokens[i].v === 'end') i++
        else throw new Error(`unclosed if ${key}`)
        nodes.push({ kind: 'if', key, thenN, elseN })
        continue
      }
      nodes.push({ kind: 'var', v })
      i++
    }
    return nodes
  }
  const ast = block(null)
  return ast
}

function evalNodes(nodes) {
  let s = ''
  for (const n of nodes) {
    if (n.kind === 'text') s += n.v
    else if (n.kind === 'var') s += lookup(n.v)
    else if (n.kind === 'if') s += evalNodes(truthy(n.key) ? n.thenN : n.elseN)
  }
  return s
}

function render(src) {
  return evalNodes(parse(tokenize(src))).replace(/\n{4,}/g, '\n\n\n')
}

const header = `# PentAGI · 官方人格内核

本席位吃官方仓库 Default 稿（Settings → Prompts 里徽章 Default 的那一套）：

- \`assistant.tmpl\` — 对用户说话、编排、分派专家
- \`pentester.tmpl\` — 渗透专家人格（授权框架、双语通道、记忆/Graphiti、结案）

工具名已映射成 Harness \`pg_*\`。禁止只把命令写在回复里。开场可 \`pg_status\`。

来源：vendor/pentagi/backend/pkg/templates/prompts/（HEAD 随仓库）

---
`

const assistant = render(readFileSync(join(tmplDir, 'assistant.tmpl'), 'utf8'))
const pentester = render(readFileSync(join(tmplDir, 'pentester.tmpl'), 'utf8'))
if (assistant.includes('{{') || pentester.includes('{{')) {
  const leftover = [...assistant.matchAll(/\{\{[^}]+\}\}/g), ...pentester.matchAll(/\{\{[^}]+\}\}/g)].map(x => x[0])
  console.error('unrendered tags', leftover.slice(0, 20))
  process.exit(1)
}
writeFileSync(out, `${header}\n# OFFICIAL assistant.tmpl\n\n${assistant.trim()}\n\n---\n\n# OFFICIAL pentester.tmpl\n\n${pentester.trim()}\n`)
console.log('wrote', out)
console.log('bytes', Buffer.byteLength(readFileSync(out)))
console.log('has pg_terminal', readFileSync(out, 'utf8').includes('pg_terminal'))
console.log('has AUTHORIZED', readFileSync(out, 'utf8').includes('AUTHORIZED penetration'))
