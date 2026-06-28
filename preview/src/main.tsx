import React from 'react'
import { createRoot } from 'react-dom/client'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { codeToTokens, type ThemedToken } from 'shiki'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { AlertCircle, Monitor, Moon, Sprout, Sun, Tag } from 'lucide-react'
import '@markgrafhq/markgraf-embed/css'
import '@markgrafhq/markgraf-embed'
import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import './style.css'

const wilmersdorfShikiTheme = {
  name: 'wilmersdorf-preview',
  type: 'dark',
  colors: {
    'editor.background': '#1f2024',
    'editor.foreground': '#eceff4',
  },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#888395', fontStyle: 'italic' } },
    { scope: ['keyword', 'storage', 'storage.type', 'support.type'], settings: { foreground: '#8ca6c8' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call'], settings: { foreground: '#93b5b3' } },
    { scope: ['entity.name.type', 'support.class', 'support.type'], settings: { foreground: '#b7a9d4' } },
    { scope: ['variable', 'meta.definition.variable'], settings: { foreground: '#eceff4' } },
    { scope: ['string', 'constant.character'], settings: { foreground: '#a7b88f' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.other'], settings: { foreground: '#c7a889' } },
    { scope: ['entity.name.tag', 'punctuation.definition.tag'], settings: { foreground: '#93b5b3' } },
    { scope: ['markup.heading', 'markup.bold'], settings: { foreground: '#eceff4', fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
  ],
}

const previewDiagnostics = ((window as unknown as { __errors?: string[] }).__errors ??= [])
const originalConsoleError = console.error.bind(console)
console.error = (...args: unknown[]) => {
  previewDiagnostics.push(args.map(String).join(' '))
  originalConsoleError(...args)
}
window.addEventListener('error', (event) => previewDiagnostics.push(event.message))
window.addEventListener('unhandledrejection', (event) => previewDiagnostics.push(String(event.reason)))

type SourceRange = {
  startLine: number
  endLine: number
}

type SourcePoint = {
  line: number
  column: number
}

type InlinePart = SourcePoint & {
  text: string
  marks: string[]
  href?: string
}

type MarkgrafNode = SourcePoint & {
  id: string
  label: string
}

type MarkgrafEdge = SourcePoint & {
  from: string
  to: string
  directed: boolean
}

type ListItem = SourceRange & {
  parts: InlinePart[]
  marker: string
  checked?: boolean
}

type TableCell = SourcePoint & {
  parts: InlinePart[]
  align: 'left' | 'center' | 'right'
}

type TableRow = SourceRange & {
  cells: TableCell[]
}

type MdNode = {
  type: string
  value?: string
  depth?: number
  lang?: string
  url?: string
  alt?: string
  ordered?: boolean
  checked?: boolean | null
  spread?: boolean
  align?: Array<'left' | 'center' | 'right' | null>
  children?: MdNode[]
  position?: {
    start: { line: number; column: number; offset: number }
    end: { line: number; column: number; offset: number }
  }
}

type Block = SourceRange & (
  | { kind: 'mdast'; node: MdNode; baseLine: number }
  | { kind: 'heading'; level: number; parts: InlinePart[] }
  | { kind: 'paragraph'; parts: InlinePart[] }
  | { kind: 'blockquote'; parts: InlinePart[] }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'table'; header: TableRow; rows: TableRow[] }
  | { kind: 'code'; language: string; code: string }
  | { kind: 'callout'; titleParts: InlinePart[]; tone: string; toneSource: SourcePoint; bodyParts: InlinePart[] }
  | { kind: 'chart'; title: string; rows: Array<{ name: string; value: number }> }
  | { kind: 'markgraf'; title: string; source: string }
)

type Frontmatter = {
  title: string
  tags: string[]
}

type Document = {
  frontmatter: Frontmatter
  body: string
  bodyStartLine: number
}

declare global {
  interface Window {
    highlightSourceLine?: (line: number) => void
    highlightSourcePosition?: (line: number, column: number, showBlock?: boolean, showCaret?: boolean, showRail?: boolean) => void
    highlightSourceRange?: (startLine: number, startColumn: number, endLine: number, endColumn: number) => void
    updateNoteSource?: (source: string) => void
    applyNoteEdit?: (start: number, end: number, replacement: string) => void
    markgraf?: { mount: (element: HTMLElement, source: string) => void; mountAll: (root?: HTMLElement) => void }
  }

  interface ImportMeta {
    hot?: {
      accept: (path: string, callback: (module: { default: string }) => void) => void
    }
  }
}

function parseDocument(source: string): Document {
  if (!source.startsWith('---')) {
    return { frontmatter: { title: 'Untitled', tags: [] }, body: source, bodyStartLine: 1 }
  }

  const end = source.indexOf('\n---', 3)
  if (end === -1) {
    return { frontmatter: { title: 'Untitled', tags: [] }, body: source, bodyStartLine: 1 }
  }

  const frontmatterSource = source.slice(3, end).trim()
  const bodyOffset = end + 5
  const body = source.slice(bodyOffset)
  const title = readField(frontmatterSource.split('\n'), 'title') ?? 'Untitled'
  const tags = (readField(frontmatterSource.split('\n'), 'tags') ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)

  return {
    frontmatter: { title, tags },
    body,
    bodyStartLine: lineAtOffset(source, bodyOffset),
  }
}

function parseNote(source: string, baseLine: number): Block[] {
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as MdNode

  return (tree.children ?? []).map((node) => ({
    kind: 'mdast',
    node,
    baseLine,
    ...mdastSourceRange(node, baseLine),
  }))
}

function mdastSourceRange(node: MdNode, baseLine: number): SourceRange {
  return {
    startLine: baseLine + (node.position?.start.line ?? 1) - 1,
    endLine: baseLine + (node.position?.end.line ?? node.position?.start.line ?? 1) - 1,
  }
}

function parseParagraph(lines: string[], startLine: number): Block {
  return {
    kind: 'paragraph',
    parts: parseInlineLines(lines, startLine, lines.map(() => 0)),
    startLine,
    endLine: startLine + lines.length - 1,
  }
}

function parseBlockquote(lines: string[], prefixLengths: number[], startLine: number): Block {
  return {
    kind: 'blockquote',
    parts: parseInlineLines(lines, startLine, prefixLengths),
    startLine,
    endLine: startLine + lines.length - 1,
  }
}

function parseInlineLines(lines: string[], startLine: number, baseColumns: number[]): InlinePart[] {
  return lines.flatMap((line, offset) => {
    const parsed = parseInline(line, startLine + offset, baseColumns[offset] ?? 0)
    if (offset === lines.length - 1) return parsed
    return [...parsed, { text: ' ', line: startLine + offset, column: (baseColumns[offset] ?? 0) + line.length, marks: [] }]
  })
}

function parseList(lines: string[], start: number, baseLine: number): { block: Block; nextIndex: number } {
  const first = parseListMarker(lines[start])
  const ordered = Boolean(first?.ordered)
  const items: ListItem[] = []
  let index = start

  while (index < lines.length) {
    const marker = parseListMarker(lines[index])
    if (!marker || marker.ordered !== ordered) break

    const task = marker.body.match(/^\[([ xX])\]\s+(.*)$/)
    const body = task ? task[2] : marker.body
    const bodyColumn = marker.prefix.length + (task ? task[0].length - task[2].length : 0)
    items.push({
      marker: marker.marker,
      checked: task ? task[1].toLowerCase() === 'x' : undefined,
      parts: parseInline(body, baseLine + index, bodyColumn),
      startLine: baseLine + index,
      endLine: baseLine + index,
    })
    index += 1
  }

  return {
    block: {
      kind: 'list',
      ordered,
      items,
      startLine: baseLine + start,
      endLine: baseLine + index - 1,
    },
    nextIndex: index,
  }
}

function parseInline(source: string, line: number, baseColumn: number, marks: string[] = []): InlinePart[] {
  const parts: InlinePart[] = []
  let index = 0

  while (index < source.length) {
    if (source.startsWith('**', index)) {
      const end = source.indexOf('**', index + 2)
      if (end !== -1) {
        parts.push(...parseInline(source.slice(index + 2, end), line, baseColumn + index + 2, [...marks, 'strong']))
        index = end + 2
        continue
      }
    }

    if (source.startsWith('~~', index)) {
      const end = source.indexOf('~~', index + 2)
      if (end !== -1) {
        parts.push(...parseInline(source.slice(index + 2, end), line, baseColumn + index + 2, [...marks, 'strike']))
        index = end + 2
        continue
      }
    }

    if (source[index] === '`') {
      const end = source.indexOf('`', index + 1)
      if (end !== -1) {
        parts.push(...chars(source.slice(index + 1, end), line, baseColumn + index + 1, [...marks, 'code']))
        index = end + 1
        continue
      }
    }

    if (source[index] === '<') {
      const end = source.indexOf('>', index + 1)
      const href = end === -1 ? undefined : source.slice(index + 1, end)
      if (href && /^https?:\/\//.test(href)) {
        parts.push(...chars(href, line, baseColumn + index + 1, [...marks, `link:${href}`]))
        index = end + 1
        continue
      }
    }

    if (/^https?:\/\//.test(source.slice(index))) {
      const match = source.slice(index).match(/^https?:\/\/[^\s)]+/)
      if (match) {
        parts.push(...chars(match[0], line, baseColumn + index, [...marks, `link:${match[0]}`]))
        index += match[0].length
        continue
      }
    }

    if (source[index] === '[') {
      const closeLabel = source.indexOf(']', index + 1)
      const openHref = closeLabel === -1 ? -1 : source.indexOf('(', closeLabel)
      const closeHref = openHref === -1 ? -1 : source.indexOf(')', openHref)
      if (closeLabel !== -1 && openHref === closeLabel + 1 && closeHref !== -1) {
        const href = source.slice(openHref + 1, closeHref)
        parts.push(...parseInline(source.slice(index + 1, closeLabel), line, baseColumn + index + 1, [...marks, `link:${href}`]))
        index = closeHref + 1
        continue
      }
    }

    parts.push({ text: source[index], line, column: baseColumn + index, marks })
    index += 1
  }

  return parts
}

function chars(source: string, line: number, baseColumn: number, marks: string[]): InlinePart[] {
  return Array.from(source).map((text, index) => ({ text, line, column: baseColumn + index, marks }))
}

function parseCallout(source: string, sourceStartLine: number): Omit<Block, keyof SourceRange> {
  const lines = source.split('\n')
  const kind = readFieldSource(lines, 'kind', sourceStartLine)
  const title = readFieldSource(lines, 'title', sourceStartLine)
  const bodyStart = lines.findIndex((line) => line.trim() === '')
  const bodyLines = bodyStart === -1 ? [] : lines.slice(bodyStart + 1)
  const bodyParts = bodyLines.flatMap((line, offset) => {
    const sourceLine = sourceStartLine + bodyStart + 1 + offset
    const parsed = parseInline(line, sourceLine, 0)
    if (offset === bodyLines.length - 1) return parsed
    return [...parsed, { text: ' ', line: sourceLine, column: line.length, marks: [] }]
  })

  return {
    kind: 'callout',
    tone: kind?.value ?? 'note',
    toneSource: kind ?? { value: 'note', line: sourceStartLine, column: 0 },
    titleParts: title ? parseInline(title.value, title.line, title.column) : chars('Note', sourceStartLine, 0, []),
    bodyParts,
  }
}

function parseChart(source: string): Omit<Block, keyof SourceRange> {
  const lines = source.trim().split('\n')
  const title = readField(lines, 'title') ?? 'Chart'
  const rows = lines
    .filter((line) => !line.startsWith('title:'))
    .map((line) => line.split(','))
    .filter((parts) => parts.length === 2)
    .map(([name, value]) => ({ name: name.trim(), value: Number(value.trim()) }))
    .filter((row) => Number.isFinite(row.value))

  return { kind: 'chart', title, rows }
}

function parseMarkgraf(source: string, _sourceStartLine: number): Omit<Block, keyof SourceRange> {
  return { kind: 'markgraf', title: 'Graph', source: normalizeMarkgrafSource(source.trim()) }
}

function normalizeMarkgrafSource(source: string): string {
  const lines = source
    .split('\n')
    .map((line) => line.replace(/^(\s*keyframe\s+)"([^"]+)"(\s*\{)/, '$1$2$3'))
    .map((line) => line.replace(/^(\s*\+node\s+\S+\s+)([^"\s].*?)\s*$/, (_match, prefix, label) => `${prefix}"${label}"`))

  if (lines.some((line) => /^\s*seed\s+/.test(line))) return lines.join('\n')
  return ['seed 1', ...lines].join('\n')
}

function parseTable(lines: string[], start: number, baseLine: number): { block: Block; nextIndex: number } {
  const headerCells = parseTableCells(lines[start], baseLine + start)
  const alignments = parseTableAlignments(lines[start + 1])
  const header = applyTableAlignments(headerCells, alignments, baseLine + start)
  const rows: TableRow[] = []
  let index = start + 2

  while (index < lines.length && looksLikeTableRow(lines[index])) {
    rows.push(applyTableAlignments(parseTableCells(lines[index], baseLine + index), alignments, baseLine + index))
    index += 1
  }

  return {
    block: { kind: 'table', header, rows, startLine: baseLine + start, endLine: baseLine + index - 1 },
    nextIndex: index,
  }
}

function parseTableCells(line: string, sourceLine: number): TableCell[] {
  const trimmedStart = line.trimStart()
  const leading = line.length - trimmedStart.length
  const contentStart = trimmedStart.startsWith('|') ? leading + 1 : leading
  const contentEnd = line.trimEnd().endsWith('|') ? line.trimEnd().length - 1 : line.length
  const content = line.slice(contentStart, contentEnd)
  let cursor = contentStart

  return content.split('|').map((cell) => {
    const leadingSpaces = cell.length - cell.trimStart().length
    const value = cell.trim()
    const column = cursor + leadingSpaces
    cursor += cell.length + 1
    return { parts: parseInline(value, sourceLine, column), line: sourceLine, column, align: 'left' }
  })
}

function parseTableAlignments(line: string): Array<'left' | 'center' | 'right'> {
  return stripTableEdges(line).split('|').map((cell) => {
    const value = cell.trim()
    if (value.startsWith(':') && value.endsWith(':')) return 'center'
    if (value.endsWith(':')) return 'right'
    return 'left'
  })
}

function applyTableAlignments(cells: TableCell[], alignments: Array<'left' | 'center' | 'right'>, line: number): TableRow {
  return {
    cells: cells.map((cell, index) => ({ ...cell, align: alignments[index] ?? 'left' })),
    startLine: line,
    endLine: line,
  }
}

function stripTableEdges(line: string): string {
  const trimmed = line.trim()
  return trimmed.replace(/^\|/, '').replace(/\|$/, '')
}

function findFenceEnd(lines: string[], start: number): number {
  const end = lines.findIndex((line, index) => index >= start && line.startsWith('```'))
  return end === -1 ? lines.length - 1 : end
}

function looksLikeBlockStart(line: string): boolean {
  return /^(#{1,6})\s+/.test(line) || /^```/.test(line) || looksLikeListItem(line) || looksLikeBlockquote(line) || looksLikeTableRow(line)
}

function looksLikeListItem(line: string): boolean {
  return Boolean(parseListMarker(line))
}

function parseListMarker(line: string): { prefix: string; marker: string; body: string; ordered: boolean } | undefined {
  const unordered = line.match(/^(\s*[-*+]\s+)(.*)$/)
  if (unordered) return { prefix: unordered[1], marker: unordered[1].trim(), body: unordered[2], ordered: false }

  const ordered = line.match(/^(\s*(\d+)[.)]\s+)(.*)$/)
  if (ordered) return { prefix: ordered[1], marker: ordered[2], body: ordered[3], ordered: true }
}

function looksLikeBlockquote(line: string): boolean {
  return /^\s*>\s?/.test(line)
}

function looksLikeTable(lines: string[], index: number): boolean {
  return looksLikeTableRow(lines[index]) && index + 1 < lines.length && looksLikeTableSeparator(lines[index + 1])
}

function looksLikeTableRow(line: string): boolean {
  return line.includes('|') && !/^\s*```/.test(line)
}

function looksLikeTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function lineAtOffset(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

function readField(lines: string[], name: string): string | undefined {
  return readFieldSource(lines, name, 1)?.value
}

type FieldSource = SourcePoint & {
  value: string
}

function readFieldSource(lines: string[], name: string, sourceStartLine: number): FieldSource | undefined {
  const prefix = `${name}:`
  const lineIndex = lines.findIndex((candidate) => candidate.startsWith(prefix))
  if (lineIndex === -1) return undefined

  const line = lines[lineIndex]
  const rawValue = line.slice(prefix.length)
  const leadingSpaces = rawValue.length - rawValue.trimStart().length
  return {
    value: rawValue.trim(),
    line: sourceStartLine + lineIndex,
    column: prefix.length + leadingSpaces,
  }
}

let currentMarkdownBody = ''
let currentMarkdownBodyStartLine = 1
let currentPreviewTheme: 'light' | 'dark' = 'dark'

type ThemeMode = 'auto' | 'light' | 'dark'

function storedThemeMode(): ThemeMode {
  const value = localStorage.getItem('markdown-preview-theme')
  if (value === 'light' || value === 'dark' || value === 'auto') return value
  return 'auto'
}

function nextThemeMode(mode: ThemeMode): ThemeMode {
  if (mode === 'auto') return 'light'
  if (mode === 'light') return 'dark'
  return 'auto'
}

function themeModeIcon(mode: ThemeMode) {
  if (mode === 'light') return <Sun size={15} />
  if (mode === 'dark') return <Moon size={15} />
  return <Monitor size={15} />
}

const initialNote = `---
title: Markdown preview
tags: preview
---

# Markdown preview

Open a Markdown file in Emacs and use \`SPC m p\` to send it here.
`

function App() {
  const [noteSource, setNoteSource] = React.useState(initialNote)
  const [themeMode, setThemeMode] = React.useState<ThemeMode>(storedThemeMode)
  const [systemTheme, setSystemTheme] = React.useState<'light' | 'dark'>(() => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  const effectiveTheme = themeMode === 'auto' ? systemTheme : themeMode
  const parsed = parseDocument(noteSource)
  currentMarkdownBody = parsed.body
  currentMarkdownBodyStartLine = parsed.bodyStartLine
  currentPreviewTheme = effectiveTheme
  const blocks = parseNote(parsed.body, parsed.bodyStartLine)

  React.useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setSystemTheme(media.matches ? 'dark' : 'light')
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  React.useEffect(() => {
    document.documentElement.dataset.theme = themeMode
    localStorage.setItem('markdown-preview-theme', themeMode)
  }, [themeMode])

  React.useEffect(() => {
    window.updateNoteSource = setNoteSource
    window.applyNoteEdit = (start: number, end: number, replacement: string) => {
      setNoteSource((source) => source.slice(0, start) + replacement + source.slice(end))
    }

    return () => {
      delete window.updateNoteSource
      delete window.applyNoteEdit
    }
  }, [])

  const pendingHighlight = React.useRef<(() => void) | undefined>(undefined)

  React.useEffect(() => {
    const requestHighlight = (highlight: () => void) => {
      pendingHighlight.current = highlight
      requestAnimationFrame(() => {
        if (pendingHighlight.current === highlight) highlight()
      })
    }

    window.highlightSourcePosition = (line: number, column: number, showBlock = true, showCaret = true, showRail = false) => {
      requestHighlight(() => applySourcePositionHighlight(line, column, showBlock, showCaret, showRail))
    }

    window.highlightSourceRange = (startLine: number, startColumn: number, endLine: number, endColumn: number) => {
      requestHighlight(() => applySourceRangeHighlight(startLine, startColumn, endLine, endColumn))
    }

    window.highlightSourceLine = (line: number) => {
      window.highlightSourcePosition?.(line, 0)
    }

    return () => {
      delete window.highlightSourceLine
      delete window.highlightSourcePosition
      delete window.highlightSourceRange
    }
  }, [])

  React.useEffect(() => {
    pendingHighlight.current?.()
  })

  const [firstBlock, ...restBlocks] = blocks

  return (
    <div className="shell">
      <button className="theme-toggle" onClick={() => setThemeMode((mode) => nextThemeMode(mode))}>
        {themeModeIcon(themeMode)} {themeMode}
      </button>
      <main className="page">
        {firstBlock ? <RenderedBlock block={firstBlock} /> : null}
        {restBlocks.map((block, index) => <RenderedBlock block={block} key={index} />)}
        <footer className="note-footer">
          <div className="note-footer-mark"><Sprout size={18} /></div>
          <div className="note-meta note-meta-bottom">
            {parsed.frontmatter.tags.map((tag) => <span className="pill" key={tag}><Tag size={12} />{tag}</span>)}
          </div>
        </footer>
      </main>
    </div>
  )
}

function documentQuerySourceBlocks(): NodeListOf<HTMLElement> {
  return document.querySelectorAll('[data-source-start][data-source-end]')
}

function applySourcePositionHighlight(line: number, column: number, showBlock: boolean, showCaret: boolean, showRail: boolean) {
  clearSourceHighlight()

  const block = findSourceElement(Array.from(documentQuerySourceBlocks()), line)
  const character = findSourceCharacter(line, column)
  const metadataTarget = findMetadataTarget(line)

  if (metadataTarget) {
    metadataTarget.classList.add('source-char-current')
    scrollIntoViewIfNeeded(metadataTarget)
    return
  }

  if (block && showBlock) {
    block.classList.add('source-current')
    if (showRail) block.classList.add('source-rail')
    scrollIntoViewIfNeeded(block)
  } else if (character) {
    scrollIntoViewIfNeeded(character.element)
  }

  if (!character && block) {
    block.appendChild(previewGapTargetFor(showCaret))
  }

  if (!character && !block) {
    showPreviewGapBetweenBlocks(Array.from(documentQuerySourceBlocks()), line, showCaret)
  }

  if (character) {
    character.element.classList.add('source-char-current')
    if (character.element.textContent === ' ') character.element.classList.add('source-char-current-space')
    if (!showCaret) character.element.classList.add('source-char-current-normal')
    if (showCaret) {
      const caret = previewCaretFor(character)
      document.body.appendChild(caret)
    }
  }
}

function applySourceRangeHighlight(startLine: number, startColumn: number, endLine: number, endColumn: number) {
  clearSourceHighlight()

  const start = normalizeSourcePosition(startLine, startColumn)
  const end = normalizeSourcePosition(endLine, endColumn)
  const lower = compareSourcePositions(start, end) <= 0 ? start : end
  const upper = compareSourcePositions(start, end) <= 0 ? end : start
  const selected = Array.from(document.querySelectorAll<HTMLElement>('[data-source-line][data-source-column]'))
    .filter((element) => {
      const position = sourcePositionFor(element)
      return compareSourcePositions(lower, position) <= 0 && compareSourcePositions(position, upper) <= 0
    })

  selected.forEach((element) => element.classList.add('source-selection'))
  if (selected[0]) scrollIntoViewIfNeeded(selected[0])
}

function scrollIntoViewIfNeeded(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  const margin = 80
  const visible = rect.top >= margin && rect.bottom <= window.innerHeight - margin
  if (!visible) element.scrollIntoView({ block: 'nearest', behavior: 'auto' })
}

function clearSourceHighlight() {
  document.querySelectorAll('.source-current').forEach((element) => {
    element.classList.remove('source-current')
    element.classList.remove('source-rail')
  })
  document.querySelectorAll('.source-char-current').forEach((element) => {
    element.classList.remove('source-char-current')
    element.classList.remove('source-char-current-normal')
    element.classList.remove('source-char-current-space')
  })
  document.querySelectorAll('.source-selection').forEach((element) => {
    element.classList.remove('source-selection')
  })
  document.querySelectorAll('.preview-caret, .preview-gap-target').forEach((element) => {
    element.remove()
  })
}

function normalizeSourcePosition(line: number, column: number): SourcePoint {
  return { line, column }
}

function sourcePositionFor(element: HTMLElement): SourcePoint {
  return {
    line: Number(element.dataset.sourceLine),
    column: Number(element.dataset.sourceColumn),
  }
}

function compareSourcePositions(left: SourcePoint, right: SourcePoint): number {
  if (left.line !== right.line) return left.line - right.line
  return left.column - right.column
}

function findSourceElement(elements: HTMLElement[], line: number): HTMLElement | undefined {
  return elements.find((element) => {
    const start = Number(element.dataset.sourceStart)
    const end = Number(element.dataset.sourceEnd)
    return start <= line && line <= end
  })
}

type SourceCharacter = {
  element: HTMLElement
  line: number
  column: number
  side: 'before' | 'after'
}

function findMetadataTarget(line: number): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(`[data-source-line="${line}"][data-source-role="metadata"]`)
}

function findSourceCharacter(line: number, column: number): SourceCharacter | undefined {
  const characters = Array.from(document.querySelectorAll<HTMLElement>(`[data-source-line="${line}"]`))
  const exact = characters.find((element) => Number(element.dataset.sourceColumn) === column)
  if (exact) return { element: exact, line, column, side: 'before' }

  const previous = characters.findLast((element) => Number(element.dataset.sourceColumn) < column)
  const next = characters.find((element) => Number(element.dataset.sourceColumn) > column)
  if (previous && !next) return { element: previous, line, column, side: 'after' }
}

function previewCaretFor(character: SourceCharacter): HTMLElement {
  const caret = document.createElement('div')
  const rect = character.element.getBoundingClientRect()
  const left = previewCaretLeft(character, rect)

  caret.className = 'preview-caret'
  caret.style.top = `${window.scrollY + rect.top}px`
  caret.style.left = `${window.scrollX + left}px`
  caret.style.height = `${Math.max(20, rect.height)}px`

  return caret
}

function previewGapTargetFor(showCaret: boolean): HTMLElement {
  const marker = document.createElement('span')
  marker.className = showCaret ? 'preview-gap-target preview-gap-caret' : 'preview-gap-target'
  marker.setAttribute('aria-hidden', 'true')

  return marker
}

function showPreviewGapBetweenBlocks(blocks: HTMLElement[], line: number, showCaret: boolean) {
  const previous = blocks.filter((element) => Number(element.dataset.sourceEnd) < line).at(-1)
  const next = blocks.find((element) => line < Number(element.dataset.sourceStart))
  const marker = previewGapTargetFor(showCaret)
  marker.classList.add('preview-gap-between')

  if (previous?.parentElement) {
    previous.insertAdjacentElement('afterend', marker)
    scrollIntoViewIfNeeded(marker)
    return
  }

  if (next?.parentElement) {
    next.insertAdjacentElement('beforebegin', marker)
    scrollIntoViewIfNeeded(marker)
  }
}

function previewCaretLeft(character: SourceCharacter, rect: DOMRect): number {
  if (character.element.textContent === ' ') return previewCaretLeftAfterSpaces(character, rect)
  if (character.side === 'after') return rect.right
  return rect.left
}

function previewCaretLeftAfterSpaces(character: SourceCharacter, fallback: DOMRect): number {
  const previous = previousNonSpaceCharacter(character.line, character.column)
  if (!previous) return character.side === 'after' ? fallback.right : fallback.left

  const previousRect = previous.getBoundingClientRect()
  const previousColumn = Number(previous.dataset.sourceColumn)
  const spacesBeforeCaret = character.side === 'after'
    ? Math.max(1, character.column - previousColumn - 1)
    : Math.max(1, character.column - previousColumn)
  return previousRect.right + spacesBeforeCaret * measuredSpaceWidth(previous)
}

function previousNonSpaceCharacter(line: number, column: number): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-source-line="${line}"]`))
    .filter((element) => Number(element.dataset.sourceColumn) < column && element.textContent !== ' ')
    .at(-1)
}

function measuredSpaceWidth(reference: HTMLElement): number {
  const probe = document.createElement('span')
  const style = getComputedStyle(reference)
  probe.textContent = '\u00a0'
  probe.style.font = style.font
  probe.style.letterSpacing = style.letterSpacing
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  document.body.appendChild(probe)
  const width = probe.getBoundingClientRect().width
  probe.remove()
  return width
}

function sourceAttributes(block: SourceRange) {
  return {
    'data-source-start': block.startLine,
    'data-source-end': block.endLine,
  }
}

function mdastPoint(point: { line: number; column: number } | undefined, baseLine: number): SourcePoint {
  return { line: baseLine + (point?.line ?? 1) - 1, column: Math.max(0, (point?.column ?? 1) - 1) }
}

function mdastAttributes(node: MdNode, baseLine: number) {
  return sourceAttributes(mdastSourceRange(node, baseLine))
}

function sourceLineIndentColumn(line: number): number {
  const source = currentMarkdownBody.split('\n')[line - currentMarkdownBodyStartLine] ?? ''
  return source.length - source.trimStart().length
}

function mdastText(value: string, start: SourcePoint) {
  const pieces: React.ReactNode[] = []
  let line = start.line
  let column = start.column

  Array.from(value).forEach((text, index) => {
    if (text === '\n') {
      pieces.push(' ')
      line += 1
      column = sourceLineIndentColumn(line)
      return
    }

    pieces.push(<span className={text === ' ' ? 'source-space' : undefined} data-source-line={line} data-source-column={column} key={`${line}:${column}:${index}`}>{text}</span>)
    column += 1
  })

  return pieces
}

function renderMdastInline(node: MdNode, baseLine: number, key: React.Key): React.ReactNode {
  const children = (node.children ?? []).map((child, index) => renderMdastInline(child, baseLine, index))
  if (node.type === 'text') return <React.Fragment key={key}>{mdastText(node.value ?? '', mdastPoint(node.position?.start, baseLine))}</React.Fragment>
  if (node.type === 'inlineCode') return <code key={key}>{mdastText(node.value ?? '', mdastPoint(node.position?.start, baseLine))}</code>
  if (node.type === 'emphasis') return <em key={key}>{children}</em>
  if (node.type === 'strong') return <strong key={key}>{children}</strong>
  if (node.type === 'delete') return <del key={key}>{children}</del>
  if (node.type === 'link') return <a href={node.url} key={key}>{children}</a>
  if (node.type === 'image') return <img alt={node.alt ?? ''} key={key} src={node.url} />
  if (node.type === 'break') return <br key={key} />
  if (node.type === 'footnoteReference') return <sup key={key}>{mdastText(node.value ?? '', mdastPoint(node.position?.start, baseLine))}</sup>
  return <React.Fragment key={key}>{children.length > 0 ? children : mdastText(node.value ?? '', mdastPoint(node.position?.start, baseLine))}</React.Fragment>
}

function renderMdastChildren(node: MdNode, baseLine: number) {
  return (node.children ?? []).map((child, index) => renderMdastInline(child, baseLine, index))
}

function withTrailingSourceSpaces(node: MdNode, baseLine: number, child: React.ReactNode, key: React.Key): React.ReactNode {
  const trailing = trailingSourceSpaceSpans(node, baseLine)
  if (trailing.length === 0) return child
  return <React.Fragment key={key}>{child}{trailing}</React.Fragment>
}

function trailingSourceSpaceSpans(node: MdNode, baseLine: number): React.ReactNode[] {
  const range = node.position
  if (!range) return []

  const lines = currentMarkdownBody.split('\n')
  const spans: React.ReactNode[] = []
  for (let line = range.start.line; line <= range.end.line; line += 1) {
    const source = lines[line - 1] ?? ''
    const trailing = source.match(/ +$/)?.[0].length ?? 0
    if (trailing === 0) continue

    const absoluteLine = baseLine + line - 1
    const startColumn = source.length - trailing
    for (let offset = 0; offset < trailing; offset += 1) {
      const column = startColumn + offset
      spans.push(<span className="source-space" data-source-line={absoluteLine} data-source-column={column} key={`trailing:${absoluteLine}:${column}`}> </span>)
    }
  }

  return spans
}

function renderMdastBlock(node: MdNode, baseLine: number, key: React.Key): React.ReactNode {
  if (node.type === 'heading') {
    const Heading = `h${Math.min(6, Math.max(1, node.depth ?? 1))}` as keyof React.JSX.IntrinsicElements
    return withTrailingSourceSpaces(node, baseLine, <Heading {...mdastAttributes(node, baseLine)}>{renderMdastChildren(node, baseLine)}</Heading>, key)
  }

  if (node.type === 'paragraph') return withTrailingSourceSpaces(node, baseLine, <p {...mdastAttributes(node, baseLine)}>{renderMdastChildren(node, baseLine)}</p>, key)

  if (node.type === 'blockquote') {
    return (
      <div className="blockquote-shell" {...mdastAttributes(node, baseLine)} key={key}>
        <blockquote>{(node.children ?? []).map((child, index) => renderMdastBlock(child, baseLine, index))}</blockquote>
      </div>
    )
  }

  if (node.type === 'list') {
    const List = node.ordered ? 'ol' : 'ul'
    return <List {...mdastAttributes(node, baseLine)} key={key}>{(node.children ?? []).map((child, index) => renderMdastListItem(child, baseLine, index, Boolean(node.ordered)))}</List>
  }

  if (node.type === 'listItem') return renderMdastListItem(node, baseLine, Number(key) || 0, false)

  if (node.type === 'table') {
    const rows = node.children ?? []
    const alignments = node.align ?? []
    return (
      <table {...mdastAttributes(node, baseLine)} key={key}>
        <thead>{rows[0] ? renderMdastTableRow(rows[0], baseLine, alignments, 'th') : null}</thead>
        <tbody>{rows.slice(1).map((row, index) => renderMdastTableRow(row, baseLine, alignments, 'td', index))}</tbody>
      </table>
    )
  }

  if (node.type === 'code') {
    const source = node.value ?? ''
    const startLine = mdastPoint(node.position?.start, baseLine).line
    if (node.lang === 'callout') return <RenderedBlock block={{ ...parseCallout(source, startLine + 1), ...mdastSourceRange(node, baseLine) }} key={key} />
    if (node.lang === 'chart') return <RenderedBlock block={{ ...parseChart(source), ...mdastSourceRange(node, baseLine) }} key={key} />
    if (node.lang === 'markgraf') return <RenderedBlock block={{ ...parseMarkgraf(source, startLine + 1), ...mdastSourceRange(node, baseLine) }} key={key} />
    return <RenderedCodeBlock attributes={mdastAttributes(node, baseLine)} key={key} language={node.lang} source={source} startLine={startLine + 1} />
  }

  if (node.type === 'thematicBreak') return <hr {...mdastAttributes(node, baseLine)} key={key} />
  if (node.type === 'html') return <RenderedCodeBlock attributes={mdastAttributes(node, baseLine)} key={key} language="html" source={node.value ?? ''} startLine={mdastPoint(node.position?.start, baseLine).line} />
  if (node.type === 'footnoteDefinition') return <aside className="footnote" {...mdastAttributes(node, baseLine)} key={key}>{(node.children ?? []).map((child, index) => renderMdastBlock(child, baseLine, index))}</aside>

  return <div {...mdastAttributes(node, baseLine)} key={key}>{renderMdastChildren(node, baseLine)}</div>
}

function renderMdastListItem(node: MdNode, baseLine: number, index: number, ordered: boolean) {
  const children = node.children ?? []
  const tightSingleParagraph = !node.spread && children.length === 1 && children[0]?.type === 'paragraph'

  return withTrailingSourceSpaces(
    node,
    baseLine,
    <li {...mdastAttributes(node, baseLine)}>
      <span className="synthetic-bullet">{ordered ? `${index + 1}.` : node.checked === null || node.checked === undefined ? '❧' : ''}</span>
      {node.checked !== null && node.checked !== undefined ? <span className={`task-box ${node.checked ? 'task-box-checked' : ''}`} /> : null}
      {tightSingleParagraph
        ? renderMdastChildren(children[0], baseLine)
        : children.map((child, childIndex) => renderMdastBlock(child, baseLine, childIndex))}
    </li>,
    index,
  )
}

function renderMdastTableRow(node: MdNode, baseLine: number, alignments: Array<'left' | 'center' | 'right' | null>, Cell: 'td' | 'th', key: React.Key = 'header') {
  return (
    <tr {...mdastAttributes(node, baseLine)} key={key}>
      {(node.children ?? []).map((cell, index) => <Cell className={`align-${alignments[index] ?? 'left'}`} key={index}>{renderMdastChildren(cell, baseLine)}</Cell>)}
    </tr>
  )
}

function RenderedBlock({ block }: { block: Block }) {
  if (block.kind === 'mdast') return renderMdastBlock(block.node, block.baseLine, 'mdast')

  if (block.kind === 'heading') {
    const Heading = `h${block.level}` as keyof React.JSX.IntrinsicElements
    return <Heading {...sourceAttributes(block)}>{renderInline(block.parts)}</Heading>
  }

  if (block.kind === 'paragraph') {
    return <p {...sourceAttributes(block)}>{renderInline(block.parts)}</p>
  }

  if (block.kind === 'blockquote') {
    return <blockquote {...sourceAttributes(block)}>{renderInline(block.parts)}</blockquote>
  }

  if (block.kind === 'list') {
    const List = block.ordered ? 'ol' : 'ul'
    return (
      <List {...sourceAttributes(block)}>
        {block.items.map((item, index) => (
          <li {...sourceAttributes(item)} key={index}>
            <span className="synthetic-bullet">{block.ordered ? `${item.marker}.` : '❧'}</span>
            {item.checked !== undefined ? <span className={`task-box ${item.checked ? 'task-box-checked' : ''}`} /> : null}
            {renderInline(item.parts)}
          </li>
        ))}
      </List>
    )
  }

  if (block.kind === 'table') {
    return (
      <table {...sourceAttributes(block)}>
        <thead {...sourceAttributes(block.header)}>
          <tr>{block.header.cells.map((cell, index) => <th className={`align-${cell.align}`} key={index}>{renderInline(cell.parts)}</th>)}</tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr {...sourceAttributes(row)} key={rowIndex}>
              {row.cells.map((cell, cellIndex) => <td className={`align-${cell.align}`} key={cellIndex}>{renderInline(cell.parts)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  if (block.kind === 'code') {
    return <RenderedCodeBlock attributes={sourceAttributes(block)} language={block.language} source={block.code} startLine={block.startLine + 1} />
  }

  if (block.kind === 'callout') {
    return (
      <aside className={`callout callout-${block.tone} source-special`} {...sourceAttributes(block)}>
        <div className="callout-title">
          <span
            className="callout-icon-source"
            data-source-line={block.toneSource.line}
            data-source-column={block.toneSource.column}
            data-source-role="metadata"
          >
            <AlertCircle size={18} />
          </span>
          <span className="callout-title-text">{renderInline(block.titleParts)}</span>
        </div>
        <div className="callout-body">{renderInline(block.bodyParts)}</div>
      </aside>
    )
  }

  if (block.kind === 'chart') {
    return (
      <figure className="chart-card source-special" {...sourceAttributes(block)}>
        <figcaption>{block.title}</figcaption>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={block.rows}>
            <XAxis dataKey="name" tickLine={false} axisLine={false} />
            <YAxis hide />
            <Bar dataKey="value" fill="var(--accent)" radius={[8, 8, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </figure>
    )
  }

  return <RenderedMarkgraf block={block} />
}

function RenderedMarkgraf({ block }: { block: Extract<Block, { kind: 'markgraf' }> }) {
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!ref.current || !window.markgraf) return
    ref.current.innerHTML = ''
    ref.current.dataset.markgrafTheme = currentPreviewTheme
    ref.current.dataset.markgrafTitles = 'false'
    window.markgraf.mount(ref.current, block.source)
  }, [block.source, currentPreviewTheme])

  return (
    <figure className="markgraf-card source-special" {...sourceAttributes(block)}>
      <div className="markgraf-stage" ref={ref} />
    </figure>
  )
}

function RenderedCodeBlock({ attributes, language, source, startLine }: { attributes: ReturnType<typeof sourceAttributes>; language?: string; source: string; startLine: number }) {
  const [tokens, setTokens] = React.useState<ThemedToken[][] | undefined>(undefined)
  const theme = currentPreviewTheme === 'dark' ? wilmersdorfShikiTheme : 'github-light'

  React.useEffect(() => {
    let cancelled = false
    codeToTokens(source, { lang: normalizeCodeLanguage(language), theme })
      .then((result) => { if (!cancelled) setTokens(result.tokens) })
      .catch((error) => {
        previewDiagnostics.push(String(error))
        if (!cancelled) setTokens(undefined)
      })
    return () => { cancelled = true }
  }, [source, language, theme])

  return <pre className="source-special" {...attributes}><code>{tokens ? renderHighlightedCode(tokens, startLine) : renderCode(source, startLine)}</code></pre>
}

function normalizeCodeLanguage(language: string | undefined): string {
  const normalized = (language ?? 'text').toLowerCase()
  if (normalized === 'purs' || normalized === 'ps') return 'purescript'
  return normalized
}

function renderHighlightedCode(lines: ThemedToken[][], startLine: number) {
  return lines.flatMap((line, lineOffset) => {
    const lineNumber = startLine + lineOffset
    let column = 0
    const characters = line.flatMap((token, tokenIndex) => Array.from(token.content).map((text, charIndex) => {
      const currentColumn = column
      column += 1
      return (
        <span
          data-source-line={lineNumber}
          data-source-column={currentColumn}
          key={`${lineNumber}:${currentColumn}:${tokenIndex}:${charIndex}`}
          className={text === ' ' ? 'source-space' : undefined}
          style={token.color ? { color: token.color } : undefined}
        >{text}</span>
      )
    }))

    if (lineOffset === lines.length - 1) return characters
    return [...characters, '\n']
  })
}

function renderCode(source: string, startLine: number) {
  const lines = source.split('\n')
  return lines.flatMap((line, lineOffset) => {
    const lineNumber = startLine + lineOffset
    const characters = Array.from(line).map((text, column) => (
      <span className={text === ' ' ? 'source-space' : undefined} data-source-line={lineNumber} data-source-column={column} key={`${lineNumber}:${column}`}>{text}</span>
    ))

    if (lineOffset === lines.length - 1) return characters
    return [...characters, '\n']
  })
}

function renderInline(parts: InlinePart[]) {
  return parts.map((part, index) => {
    const character = <span className={part.text === ' ' ? 'source-space' : undefined} data-source-line={part.line} data-source-column={part.column}>{part.text}</span>
    const href = part.marks.find((mark) => mark.startsWith('link:'))?.slice('link:'.length)
    const wrapped = part.marks.reduce((child, mark) => {
      if (mark === 'strong') return <strong>{child}</strong>
      if (mark === 'strike') return <del>{child}</del>
      if (mark === 'code') return <code>{child}</code>
      return child
    }, character as React.ReactNode)

    if (href) return <a href={href} key={index}>{wrapped}</a>
    return <React.Fragment key={index}>{wrapped}</React.Fragment>
  })
}

createRoot(document.getElementById('root')!).render(<App />)
