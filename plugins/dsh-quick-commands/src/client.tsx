// dsh-quick-commands — CLIENT half. A composer control that lists the shared
// quick commands, inserts them into the input, and manages them (add / edit /
// delete / pin / drag-reorder / import / export). The table is authoritative on
// the host (shared with the sibling app); this half fetches it, renders it, and
// posts mutations, re-seating on the host's returned table. A `/` at the start
// of the draft opens an inline filter over the same list.
//
// No harness UI imports (icons are inline SVG) so the bundle stays self-contained.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  QUICK_COMMANDS_FILTER_THRESHOLD, QUICK_COMMAND_OVERLAY_MARGIN, appendQuickCommandText,
  filterQuickCommands, isPinned, parseImportPayload, resolveQuickCommandPlacement,
} from './quick-commands-core.mjs'

const NS = 'dsh-quick-commands'
const CLIENT_BUNDLE_ID = 'dsh-quick-commands'
const ROUTE_PREFIX = '/dsh-quick-commands'

// The Harness platform owns "/". Its slash pipeline
// (@deepseek-ai/dsh-client-ui-input-trigger) only ever binds
// TriggerChar '/' | '@', and the built-in 命令 palette (compact / export /
// feedback / goal …) opens on any trimmed "/"-leading draft. An inline filter of
// our own therefore fights the platform for the same keystroke and the same
// screen space — both overlays render at z-index 1200, so ours covered the
// palette. The inline "/" filter is consequently OFF: the composer button is the
// only entry point. Flip to true only if the platform trigger moves off "/".
const SLASH_FILTER_ENABLED = false

// ---- i18n -------------------------------------------------------------------

const zh = {
  'button': '快捷指令',
  'panel.title': '快捷指令',
  'panel.filter': '筛选指令…',
  'panel.empty': '还没有快捷指令',
  'panel.emptyFiltered': '没有匹配的指令',
  'panel.new': '新建一条快捷指令…',
  'panel.add': '添加',
  'panel.saveCurrent': '存为输入',
  'panel.import': '导入',
  'panel.export': '导出',
  'panel.reset': '恢复默认',
  'panel.resetConfirm': '恢复为默认五条？现有指令将被替换。',
  'panel.shared': '与 Pchat 助手共享',
  'row.insert': '插入到输入框',
  'row.pin': '置顶',
  'row.unpin': '取消置顶',
  'row.edit': '编辑',
  'row.delete': '删除',
  'row.deleteConfirm': '删除这条快捷指令？',
  'row.save': '保存',
  'row.cancel': '取消',
  'row.drag': '拖动排序',
  'import.mode': '导入方式',
  'import.replace': '替换全部',
  'import.merge': '合并追加',
  'import.confirm': '导入',
  'import.cancel': '取消',
  'import.preview': '共 {count} 条可导入' ,
  'import.dropped': '（{dropped} 条空白已忽略）',
  'import.done': '已导入 {imported} 条，跳过 {skipped} 条',
  'import.empty': '文件里没有可导入的指令',
  'slash.hint': '快捷指令 — ↑↓ 选择 · Enter 插入 · Esc 关闭',
  'error.generic': '操作失败',
}

const en: Record<keyof typeof zh, string> = {
  'button': 'Quick commands',
  'panel.title': 'Quick commands',
  'panel.filter': 'Filter commands…',
  'panel.empty': 'No quick commands yet',
  'panel.emptyFiltered': 'No matching commands',
  'panel.new': 'New quick command…',
  'panel.add': 'Add',
  'panel.saveCurrent': 'Save input',
  'panel.import': 'Import',
  'panel.export': 'Export',
  'panel.reset': 'Reset defaults',
  'panel.resetConfirm': 'Reset to the five defaults? Existing commands will be replaced.',
  'panel.shared': 'Shared with Pchat',
  'row.insert': 'Insert into input',
  'row.pin': 'Pin',
  'row.unpin': 'Unpin',
  'row.edit': 'Edit',
  'row.delete': 'Delete',
  'row.deleteConfirm': 'Delete this quick command?',
  'row.save': 'Save',
  'row.cancel': 'Cancel',
  'row.drag': 'Drag to reorder',
  'import.mode': 'Import mode',
  'import.replace': 'Replace all',
  'import.merge': 'Merge',
  'import.confirm': 'Import',
  'import.cancel': 'Cancel',
  'import.preview': '{count} command(s) ready',
  'import.dropped': ' ({dropped} blank ignored)',
  'import.done': 'Imported {imported}, skipped {skipped}',
  'import.empty': 'No importable commands in the file',
  'slash.hint': 'Quick commands — ↑↓ select · Enter insert · Esc close',
  'error.generic': 'Operation failed',
}

type CopyKey = keyof typeof zh
type Translate = (key: CopyKey, params?: Record<string, string | number>) => string

/** Fallback translator when the host did not inject one (runtime language sniff). */
function fallbackTranslate(key: CopyKey, params?: Record<string, string | number>): string {
  const dict = typeof navigator !== 'undefined' && navigator.language.startsWith('zh') ? zh : en
  let text: string = dict[key] ?? key
  if (params) for (const [k, v] of Object.entries(params)) text = text.replace(`{${k}}`, String(v))
  return text
}

// ---- types ------------------------------------------------------------------

interface QuickCommand { id: string; text: string; pinned?: boolean }

interface ClientProps {
  sessionId: string
  input: { draft: string; phase: string }
  inputActions: { setDraft(text: string): void }
  useInput?: <T>(selector: (state: { draft: string }) => T) => T
  t?: Translate
}

// ---- host RPC (HTTP is the only client↔host channel) ------------------------

async function call(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${ROUTE_PREFIX}${path}`, init)
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}
const post = (path: string, body: unknown): Promise<any> =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// ---- inline icons -----------------------------------------------------------

function Glyph({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={d} stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
const ICON = {
  pin: 'M6 2h4l-.5 3.5L11.5 8H4l2-2.5L6 2Zm2 6v6',
  edit: 'M11 2.5 13.5 5 6 12.5l-3 .5.5-3L11 2.5Z',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5',
  close: 'M4 4l8 8M12 4l-8 8',
  plus: 'M8 3v10M3 8h10',
  drag: 'M6 4.5h.01M10 4.5h.01M6 8h.01M10 8h.01M6 11.5h.01M10 11.5h.01',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm3.6-1.4L14 14',
  importSvg: 'M8 2v8m0 0L5 7m3 3 3-3M3 13h10',
  exportSvg: 'M8 10V2m0 0L5 5m3-3 3 3M3 13h10',
}

// The quick-commands glyph (notepad + pen), copied from the Pchat composer
// icon set. 1024 viewBox, filled, tints with the button's currentColor.
const QUICK_COMMANDS_PATHS = [
  'M230.4 690.688c-16.384 0-30.208 13.312-30.208 30.208s13.312 30.208 30.208 30.208h281.6c16.384 0 30.208-13.312 30.208-30.208s-13.312-30.208-30.208-30.208H230.4zM695.808 296.96c0-16.384-13.312-30.208-29.696-30.208H230.4c-16.384 0-30.208 13.312-30.208 30.208s13.312 30.208 30.208 30.208h435.2c16.384-0.512 30.208-13.824 30.208-30.208zM636.928 508.928c0-16.384-13.312-30.208-30.208-30.208H230.4c-16.384 0-30.208 13.312-30.208 30.208s13.312 30.208 30.208 30.208h376.32c16.384-0.512 30.208-13.824 30.208-30.208z',
  'M583.68 912.896H108.544c-8.192 0-15.36-6.144-16.384-14.336V125.952c0-2.048 0.512-4.608 2.048-6.656 3.584-5.632 9.728-8.704 15.872-8.704h676.352c6.656 0 12.8 3.584 15.872 9.216 1.024 2.048 1.536 4.096 1.536 6.144v316.416c-0.512 16.896 12.288 30.72 29.184 31.744 16.896 0.512 30.72-12.288 31.744-29.184V126.464c0-19.456-7.68-37.888-21.504-51.712-15.36-14.848-35.328-23.552-56.832-23.552H109.568C66.56 51.2 31.232 84.992 31.232 126.464v771.584c0 41.472 35.328 75.264 78.848 75.264H583.68c16.384-0.512 29.184-14.848 28.672-31.232-0.512-15.872-13.312-28.672-28.672-29.184z',
  'M977.92 523.776l-22.016-22.016c-19.968-19.968-52.224-19.968-72.192 0l-264.704 264.192L593.92 885.76l120.32-24.576 264.192-264.704c19.456-19.968 19.456-52.224-0.512-72.704z m-31.232 40.96l-254.976 254.976-41.472 9.728 9.728-41.472 254.976-254.976c2.56-2.56 7.168-2.56 9.728 0l22.016 22.016c1.536 1.536 2.048 3.072 2.048 5.12s-1.024 3.584-2.048 4.608z',
]

function measureChrome(anchorEl: HTMLElement, viewport: { width: number; height: number }) {
  const trigger = anchorEl.getBoundingClientRect()
  const column = anchorEl.closest('[data-phase]')
  const header = column?.querySelector(':scope > header')
  const seat = anchorEl.closest('[data-composer-seat]')
  const headerRect = header instanceof HTMLElement && header.offsetParent !== null
    ? header.getBoundingClientRect()
    : null
  const seatRect = seat instanceof HTMLElement ? seat.getBoundingClientRect() : null
  const inset = {
    top: headerRect !== null && headerRect.height > 1
      ? headerRect.bottom + QUICK_COMMAND_OVERLAY_MARGIN
      : QUICK_COMMAND_OVERLAY_MARGIN,
    right: QUICK_COMMAND_OVERLAY_MARGIN,
    bottom: QUICK_COMMAND_OVERLAY_MARGIN + 8,
    left: QUICK_COMMAND_OVERLAY_MARGIN,
  }
  return {
    inset,
    anchor: {
      top: seatRect?.top ?? trigger.top,
      bottom: seatRect?.bottom ?? trigger.bottom,
      left: trigger.left,
      right: trigger.right,
      width: trigger.width,
      height: (seatRect?.bottom ?? trigger.bottom) - (seatRect?.top ?? trigger.top),
    },
    maxBand: Math.max(80, viewport.height - inset.top - inset.bottom),
  }
}

function QuickCommandsGlyph({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" fill="currentColor" aria-hidden>
      {QUICK_COMMANDS_PATHS.map((d, index) => <path key={index} d={d} />)}
    </svg>
  )
}

// ---- one command row --------------------------------------------------------

function Row({
  command, t, onInsert, onPin, onEdit, onDelete, drag,
}: {
  command: QuickCommand
  t: Translate
  onInsert: () => void
  onPin: () => void
  onEdit: (text: string) => void
  onDelete: () => void
  drag: {
    onDragStart: () => void
    onDragOver: (event: React.DragEvent) => void
    onDrop: () => void
    onDragEnd: () => void
    dragging: boolean
  }
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(command.text)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => { if (editing) { areaRef.current?.focus(); areaRef.current?.select() } }, [editing])

  const commitEdit = () => {
    const next = text.trim()
    if (next !== '' && next !== command.text) onEdit(next)
    setEditing(false)
  }

  if (editing) {
    return (
      <li className="dqc-row dqc-row-editing">
        <textarea
          ref={areaRef}
          className="dqc-edit"
          value={text}
          rows={Math.min(8, Math.max(2, text.split('\n').length))}
          onChange={event => { setText(event.target.value) }}
          onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); setText(command.text); setEditing(false) }
            else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); commitEdit() }
          }}
        />
        <div className="dqc-edit-actions">
          <button type="button" className="dqc-btn dqc-btn-primary" onClick={commitEdit}>{t('row.save')}</button>
          <button type="button" className="dqc-btn" onClick={() => { setText(command.text); setEditing(false) }}>{t('row.cancel')}</button>
        </div>
      </li>
    )
  }

  return (
    <li
      className={`dqc-row${drag.dragging ? ' dqc-row-dragging' : ''}${isPinned(command) ? ' dqc-row-pinned' : ''}`}
      draggable
      onDragStart={drag.onDragStart}
      onDragOver={drag.onDragOver}
      onDrop={drag.onDrop}
      onDragEnd={drag.onDragEnd}
    >
      <span className="dqc-handle" title={t('row.drag')} aria-hidden><Glyph d={ICON.drag} /></span>
      <button type="button" className="dqc-text" title={t('row.insert')} onClick={onInsert}>{command.text}</button>
      <span className="dqc-row-actions">
        <button type="button" className={`dqc-icon${isPinned(command) ? ' dqc-icon-on' : ''}`} title={isPinned(command) ? t('row.unpin') : t('row.pin')} aria-label={isPinned(command) ? t('row.unpin') : t('row.pin')} onClick={onPin}><Glyph d={ICON.pin} /></button>
        <button type="button" className="dqc-icon" title={t('row.edit')} aria-label={t('row.edit')} onClick={() => { setText(command.text); setEditing(true) }}><Glyph d={ICON.edit} /></button>
        <button type="button" className="dqc-icon dqc-icon-danger" title={t('row.delete')} aria-label={t('row.delete')} onClick={() => { if (window.confirm(t('row.deleteConfirm'))) onDelete() }}><Glyph d={ICON.trash} /></button>
      </span>
    </li>
  )
}

// ---- the panel --------------------------------------------------------------

function Panel({
  t, commands, error, onClose, currentDraft, overlayRef,
  onInsert, onCreate, onUpdate, onDelete, onPin, onReorder, onImport, onReset, onExport,
}: {
  t: Translate
  commands: QuickCommand[]
  error: string | null
  onClose: () => void
  currentDraft: string
  overlayRef: React.Ref<HTMLDivElement>
  onInsert: (command: QuickCommand) => void
  onCreate: (text: string) => void
  onUpdate: (id: string, text: string) => void
  onDelete: (id: string) => void
  onPin: (id: string, pinned: boolean) => void
  onReorder: (ids: string[]) => void
  onImport: (file: File, mode: 'replace' | 'merge') => void
  onReset: () => void
  onExport: () => void
}) {
  const [query, setQuery] = useState('')
  const [draftNew, setDraftNew] = useState('')
  const [adding, setAdding] = useState(false)
  const [order, setOrder] = useState<QuickCommand[]>(commands)
  const dragId = useRef<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const pendingFile = useRef<File | null>(null)
  const [importMode, setImportMode] = useState<'replace' | 'merge'>('merge')
  const [pickedFile, setPickedFile] = useState<File | null>(null)

  // Re-seat local order whenever the authoritative table changes.
  useEffect(() => { setOrder(commands) }, [commands])

  const filtered = useMemo(() => filterQuickCommands(order, query), [order, query])
  const showFilter = order.length > QUICK_COMMANDS_FILTER_THRESHOLD
  const dndEnabled = query.trim() === ''

  const sameRegion = (a: string, b: string): boolean => {
    const ca = order.find(c => c.id === a); const cb = order.find(c => c.id === b)
    return ca !== undefined && cb !== undefined && isPinned(ca) === isPinned(cb)
  }

  const dragOver = (overId: string) => (event: React.DragEvent) => {
    event.preventDefault()
    const id = dragId.current
    if (id === null || id === overId || !sameRegion(id, overId)) return
    setOrder(prev => {
      const from = prev.findIndex(c => c.id === id)
      const to = prev.findIndex(c => c.id === overId)
      if (from < 0 || to < 0) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }
  const commitOrder = () => {
    dragId.current = null
    const ids = order.map(c => c.id)
    const original = commands.map(c => c.id)
    if (ids.length === original.length && ids.some((id, i) => id !== original[i])) onReorder(ids)
  }

  const beginImport = () => fileRef.current?.click()
  const onFilePicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null
    event.target.value = ''
    if (file === null) return
    pendingFile.current = file
    setPickedFile(file)
  }
  const confirmImport = () => {
    if (pickedFile !== null) onImport(pickedFile, importMode)
    setPickedFile(null); pendingFile.current = null
  }

  return (
    <div ref={overlayRef} className="dqc-panel" role="dialog" aria-label={t('panel.title')} onMouseDown={event => event.stopPropagation()}>
      <div className="dqc-panel-head">
        <span className="dqc-panel-title">{t('panel.title')}</span>
        <span className="dqc-panel-shared">{t('panel.shared')}</span>
        <button type="button" className="dqc-icon" aria-label={t('row.cancel')} onClick={onClose}><Glyph d={ICON.close} /></button>
      </div>

      {showFilter && (
        <label className="dqc-filter">
          <span className="dqc-filter-glyph" aria-hidden><Glyph d={ICON.search} /></span>
          <input className="dqc-filter-input" value={query} placeholder={t('panel.filter')} onChange={event => { setQuery(event.target.value) }} />
        </label>
      )}

      {error !== null && <div className="dqc-error">{error}</div>}

      <ul className="dqc-list">
        {filtered.length === 0
          ? <li className="dqc-list-empty">{query.trim() === '' ? t('panel.empty') : t('panel.emptyFiltered')}</li>
          : filtered.map(command => (
            <Row
              key={command.id}
              command={command}
              t={t}
              onInsert={() => onInsert(command)}
              onPin={() => onPin(command.id, !isPinned(command))}
              onEdit={(text) => onUpdate(command.id, text)}
              onDelete={() => onDelete(command.id)}
              drag={dndEnabled ? {
                onDragStart: () => { dragId.current = command.id },
                onDragOver: dragOver(command.id),
                onDrop: commitOrder,
                onDragEnd: commitOrder,
                dragging: false,
              } : {
                onDragStart: () => {}, onDragOver: () => {}, onDrop: () => {}, onDragEnd: () => {}, dragging: false,
              }}
            />
          ))}
      </ul>

      {adding && (
        <div className="dqc-new">
          <textarea
            className="dqc-new-input"
            value={draftNew}
            placeholder={t('panel.new')}
            autoFocus
            rows={Math.min(6, Math.max(2, draftNew.split('\n').length))}
            onChange={event => { setDraftNew(event.target.value) }}
            onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); setDraftNew(''); setAdding(false) }
              else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && draftNew.trim() !== '') {
                event.preventDefault(); onCreate(draftNew.trim()); setDraftNew(''); setAdding(false)
              }
            }}
          />
          <div className="dqc-new-actions">
            <button type="button" className="dqc-btn dqc-btn-primary" disabled={draftNew.trim() === ''} onClick={() => { onCreate(draftNew.trim()); setDraftNew(''); setAdding(false) }}>{t('panel.add')}</button>
            <button type="button" className="dqc-btn" onClick={() => { setDraftNew(''); setAdding(false) }}>{t('row.cancel')}</button>
          </div>
        </div>
      )}

      <div className="dqc-foot">
        <button type="button" className="dqc-btn dqc-btn-ghost" data-active={adding} onClick={() => setAdding(value => !value)}><Glyph d={ICON.plus} size={14} /> {t('panel.add')}</button>
        <button type="button" className="dqc-btn dqc-btn-ghost" disabled={currentDraft.trim() === ''} title={t('panel.saveCurrent')} onClick={() => onCreate(currentDraft.trim())}>{t('panel.saveCurrent')}</button>
        <span className="dqc-foot-spacer" />
        <button type="button" className="dqc-icon" title={t('panel.import')} aria-label={t('panel.import')} onClick={beginImport}><Glyph d={ICON.importSvg} size={15} /></button>
        <button type="button" className="dqc-icon" title={t('panel.export')} aria-label={t('panel.export')} onClick={onExport}><Glyph d={ICON.exportSvg} size={15} /></button>
        <button type="button" className="dqc-btn dqc-btn-ghost" title={t('panel.reset')} onClick={() => { if (window.confirm(t('panel.resetConfirm'))) onReset() }}>{t('panel.reset')}</button>
      </div>

      <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onFilePicked} />

      {pickedFile !== null && (
        <div className="dqc-import" onMouseDown={event => event.stopPropagation()}>
          <div className="dqc-import-name">{pickedFile.name}</div>
          <div className="dqc-import-modes">
            <label><input type="radio" name="dqc-import-mode" checked={importMode === 'merge'} onChange={() => setImportMode('merge')} /> {t('import.merge')}</label>
            <label><input type="radio" name="dqc-import-mode" checked={importMode === 'replace'} onChange={() => setImportMode('replace')} /> {t('import.replace')}</label>
          </div>
          <div className="dqc-import-actions">
            <button type="button" className="dqc-btn dqc-btn-primary" onClick={confirmImport}>{t('import.confirm')}</button>
            <button type="button" className="dqc-btn" onClick={() => { setPickedFile(null); pendingFile.current = null }}>{t('import.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- slash overlay ----------------------------------------------------------

function SlashOverlay({ t, matches, active, onPick, overlayRef }: {
  t: Translate
  matches: QuickCommand[]
  active: number
  onPick: (command: QuickCommand) => void
  overlayRef: React.Ref<HTMLDivElement>
}) {
  return (
    <div ref={overlayRef} className="dqc-slash" role="listbox">
      <div className="dqc-slash-hint">{t('slash.hint')}</div>
      {matches.map((command, index) => (
        <button
          type="button"
          key={command.id}
          role="option"
          aria-selected={index === active}
          className={`dqc-slash-item${index === active ? ' dqc-slash-item-active' : ''}`}
          onMouseDown={event => { event.preventDefault(); onPick(command) }}
        >
          {isPinned(command) && <span className="dqc-slash-pin" aria-hidden><Glyph d={ICON.pin} size={12} /></span>}
          <span className="dqc-slash-text">{command.text}</span>
        </button>
      ))}
    </div>
  )
}

// ---- entry: the composer button + panel + slash -----------------------------

function QuickCommands({ input, inputActions, useInput, t: injected }: ClientProps) {
  const t = injected ?? fallbackTranslate
  const [open, setOpen] = useState(false)
  const [commands, setCommands] = useState<QuickCommand[]>([])
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const slashRef = useRef<HTMLDivElement | null>(null)
  const lastPlace = useRef('')

  const placeOverlay = useCallback((overlayEl: HTMLElement) => {
    const anchorEl = triggerRef.current ?? rootRef.current
    if (anchorEl === null) return
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const chrome = measureChrome(anchorEl, viewport)
    overlayEl.style.position = 'fixed'
    overlayEl.style.right = 'auto'
    overlayEl.style.bottom = 'auto'
    overlayEl.style.maxHeight = `${chrome.maxBand}px`
    overlayEl.style.maxWidth = `${Math.max(0, viewport.width - chrome.inset.left - chrome.inset.right)}px`
    const place = resolveQuickCommandPlacement({
      anchor: chrome.anchor,
      panelWidth: overlayEl.offsetWidth,
      panelHeight: overlayEl.offsetHeight,
      viewport,
      inset: chrome.inset,
    })
    const key = `${place.side}:${place.top}:${place.left}:${place.maxHeight}:${place.maxWidth}`
    if (lastPlace.current === key) return
    lastPlace.current = key
    overlayEl.style.top = `${place.top}px`
    overlayEl.style.left = `${place.left}px`
    overlayEl.style.maxHeight = `${place.maxHeight}px`
    overlayEl.style.maxWidth = `${place.maxWidth}px`
    overlayEl.dataset.side = place.side
  }, [])

  // Reactive draft (for slash + "save current"). Falls back to point-in-time.
  const reactiveDraft = useInput ? useInput(state => state?.draft ?? '') : input.draft
  const draft = typeof reactiveDraft === 'string' ? reactiveDraft : input.draft

  const refresh = useCallback(async () => {
    try { const data = await call('/list'); setCommands(data.commands); setError(null) }
    catch (err) { setError(err instanceof Error ? err.message : t('error.generic')) }
  }, [t])

  // Load on first open and whenever re-opened (picks up the other app's edits).
  useEffect(() => { if (open) void refresh() }, [open, refresh])

  const run = useCallback(async (work: Promise<any>) => {
    try { const data = await work; if (Array.isArray(data.commands)) setCommands(data.commands); setError(null) }
    catch (err) { setError(err instanceof Error ? err.message : t('error.generic')); void refresh() }
  }, [refresh, t])

  const insert = useCallback((command: QuickCommand) => {
    inputActions.setDraft(appendQuickCommandText(input.draft, command.text))
    setOpen(false)
  }, [inputActions, input])

  const exportAll = useCallback(async () => {
    try {
      const data = await call('/export')
      const blob = new Blob([`${JSON.stringify(data.payload, null, 2)}\n`], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = data.fileName ?? 'quick_commands.json'
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) { setError(err instanceof Error ? err.message : t('error.generic')) }
  }, [t])

  const importFile = useCallback(async (file: File, mode: 'replace' | 'merge') => {
    try {
      const parsed = parseImportPayload(await file.text())
      if (!parsed.ok) { setError(parsed.error); return }
      if (parsed.texts.length === 0) { setError(t('import.empty')); return }
      await run(post('/import', { texts: parsed.texts, mode }))
    } catch (err) { setError(err instanceof Error ? err.message : t('error.generic')) }
  }, [run, t])

  // Close the panel on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      const inTrigger = rootRef.current !== null && rootRef.current.contains(target)
      const inPanel = panelRef.current !== null && panelRef.current.contains(target)
      if (!inTrigger && !inPanel) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey) }
  }, [open])

  // ---- slash: "/" at the start of the draft opens an inline filter ----------
  // Disabled by default (see SLASH_FILTER_ENABLED): "/" belongs to the platform
  // command palette, and this overlay would cover it.
  const slashQuery = SLASH_FILTER_ENABLED && !open && draft.startsWith('/') && !draft.includes('\n')
    ? draft.slice(1)
    : null
  const [dismissedSlash, setDismissedSlash] = useState<string | null>(null)
  const [slashActive, setSlashActive] = useState(0)
  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : filterQuickCommands(commands, slashQuery).slice(0, 8)),
    [slashQuery, commands],
  )
  const slashOpen = slashQuery !== null && draft !== dismissedSlash && slashMatches.length > 0

  useLayoutEffect(() => {
    const overlayEl = open ? panelRef.current : slashOpen ? slashRef.current : null
    if (overlayEl === null) {
      lastPlace.current = ''
      return
    }
    const run = () => placeOverlay(overlayEl)
    run()
    window.addEventListener('resize', run)
    const observer = new ResizeObserver(run)
    observer.observe(overlayEl)
    return () => { window.removeEventListener('resize', run); observer.disconnect() }
  }, [open, slashOpen, commands, error, placeOverlay])

  // Keep the shared table warm so slash can filter without opening the panel.
  useEffect(() => { if (slashQuery !== null && commands.length === 0) void refresh() }, [slashQuery, commands.length, refresh])
  useEffect(() => { setSlashActive(0) }, [slashQuery])

  const pickSlash = useCallback((command: QuickCommand) => {
    inputActions.setDraft(command.text)
    setDismissedSlash(null)
  }, [inputActions])

  useEffect(() => {
    if (!slashOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setSlashActive(index => Math.min(index + 1, slashMatches.length - 1)) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setSlashActive(index => Math.max(index - 1, 0)) }
      else if (event.key === 'Enter') { event.preventDefault(); const command = slashMatches[slashActive]; if (command) pickSlash(command) }
      else if (event.key === 'Escape') { event.preventDefault(); setDismissedSlash(draft) }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [slashOpen, slashMatches, slashActive, pickSlash, draft])

  return (
    <div className="dqc-root" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`dqc-trigger${open ? ' dqc-trigger-on' : ''}`}
        aria-label={t('button')}
        aria-expanded={open}
        title={t('button')}
        onClick={() => setOpen(value => !value)}
      >
        <QuickCommandsGlyph />
      </button>

      {open && createPortal(
        <Panel
          t={t}
          commands={commands}
          error={error}
          currentDraft={draft}
          overlayRef={panelRef}
          onClose={() => setOpen(false)}
          onInsert={insert}
          onCreate={(text) => run(post('/create', { text }))}
          onUpdate={(id, text) => run(post('/update', { id, text }))}
          onDelete={(id) => run(post('/remove', { id }))}
          onPin={(id, pinned) => run(post('/pin', { id, pinned }))}
          onReorder={(ids) => run(post('/reorder', { ids }))}
          onImport={importFile}
          onReset={() => run(post('/reset', {}))}
          onExport={exportAll}
        />,
        document.body,
      )}

      {slashOpen && createPortal(
        <SlashOverlay t={t} matches={slashMatches} active={slashActive} onPick={pickSlash} overlayRef={slashRef} />,
        document.body,
      )}
    </div>
  )
}

// ---- styles -----------------------------------------------------------------

const STYLES = String.raw`
.dqc-root{position:relative;display:inline-flex}
.dqc-trigger{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:none;border-radius:8px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer}
.dqc-trigger:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover-solid)}
.dqc-trigger-on{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover-solid)}
.dqc-panel{position:fixed;z-index:1200;display:flex;flex-direction:column;width:min(420px,calc(100vw - 32px));max-height:min(60vh,520px);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv2);overflow:hidden}
.dqc-panel-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dqc-panel-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dqc-panel-shared{flex:1;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dqc-filter{display:flex;align-items:center;gap:6px;margin:8px 12px 0;padding:0 8px;height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dqc-filter-glyph{display:flex;color:var(--dsw-alias-label-tertiary)}
.dqc-filter-input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dqc-error{margin:8px 12px 0;padding:6px 8px;border-radius:6px;font-size:12px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.dqc-list{flex:1;min-height:0;overflow-y:auto;margin:8px 0 0;padding:0 8px;list-style:none;display:flex;flex-direction:column;gap:2px}
.dqc-list-empty{padding:20px 12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dqc-row{position:relative;display:flex;align-items:center;gap:4px;padding:4px 4px 4px 2px;border-radius:8px}
.dqc-row:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.dqc-row-pinned{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent)}
.dqc-row-dragging{opacity:.5}
.dqc-handle{display:flex;align-items:center;color:var(--dsw-alias-label-tertiary);cursor:grab}
.dqc-text{flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;padding:2px 4px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;white-space:pre-wrap}
.dqc-row-actions{position:absolute;top:3px;right:3px;display:flex;align-items:center;gap:1px;padding:1px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover-solid);box-shadow:0 0 0 5px var(--dsw-alias-interactive-bg-hover-solid);opacity:0;pointer-events:none;transition:opacity .1s}
.dqc-row:hover .dqc-row-actions{opacity:1;pointer-events:auto}
.dqc-icon{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:6px;color:var(--dsw-alias-label-tertiary);background:transparent;cursor:pointer}
.dqc-icon:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover-solid)}
.dqc-icon-on{color:var(--dsw-alias-brand-primary)}
.dqc-icon-danger:hover{color:var(--dsw-alias-state-error-primary)}
.dqc-row-editing{flex-direction:column;align-items:stretch;gap:6px;padding:8px}
.dqc-edit{width:100%;box-sizing:border-box;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px}
.dqc-edit-actions,.dqc-new-actions,.dqc-import-actions,.dqc-import-modes{display:flex;gap:8px;align-items:center}
.dqc-btn{display:inline-flex;align-items:center;gap:4px;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);font:inherit;font-size:12px;cursor:pointer}
.dqc-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover-solid)}
.dqc-btn:disabled{opacity:.5;cursor:default}
.dqc-btn-primary{border-color:transparent;color:#fff;background:var(--dsw-alias-brand-primary)}
.dqc-btn-primary:hover:not(:disabled){filter:brightness(1.05);color:#fff}
.dqc-btn-ghost{border-color:transparent;background:transparent}
.dqc-btn-ghost[data-active='true']{color:var(--dsw-alias-brand-primary)}
.dqc-new{display:flex;flex-direction:column;gap:6px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dqc-new-input{width:100%;box-sizing:border-box;resize:vertical;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px}
.dqc-foot{display:flex;align-items:center;gap:4px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dqc-foot-spacer{flex:1}
.dqc-import{display:flex;flex-direction:column;gap:8px;padding:12px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dqc-import-name{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dqc-import-modes{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dqc-slash{position:fixed;z-index:1200;display:flex;flex-direction:column;width:min(460px,calc(100vw - 32px));max-height:320px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv2);padding:4px}
.dqc-slash-hint{padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dqc-slash-item{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}
.dqc-slash-item:hover,.dqc-slash-item-active{background:var(--dsw-alias-interactive-bg-hover-solid)}
.dqc-slash-pin{display:flex;color:var(--dsw-alias-brand-primary);padding-top:2px}
.dqc-slash-text{flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}
`

function installStyles(): () => void {
  if (document.querySelector(`style[data-plugin="${CLIENT_BUNDLE_ID}"]`) !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = CLIENT_BUNDLE_ID
  style.textContent = STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}

// ---- registration -----------------------------------------------------------

export const inject = ['slots', 'locale']

export function apply(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-quick-commands: dictionaries')
  ctx.effect(installStyles, 'dsh-quick-commands: styles')
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    { name: 'conversation.input.left', id: 'dsh-quick-commands', order: 100, locale: NS },
    QuickCommands,
  ))
}

export const internals = { QuickCommands, Panel, Row }
