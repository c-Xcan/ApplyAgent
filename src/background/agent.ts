// Agent 主循环：快照 → 整页规划 → 批量执行 → 回读验证 → 工具调用修复 → (下一步) → 沉淀经验。
import { emptySite, type Action, type ActionResult, type BlockKey, type ConfirmDecision, type ConfirmItem, type FieldNode, type FieldOutcome, type FillPlan, type FormSnapshot, type ModelConfig, type PlanAction, type Profile, type QA, type RunEvent, type Settings, type SiteMemory, type StoredFile } from '../shared/types'
import { store } from '../shared/storage'
import { act as act0, ensureInjected, resetDumps, snapshotTab as snapshotTab0, waitStable as waitStable0, watchEdits } from './frames'
import { timing } from './timing'
import { chat, chatJson, usage, type Msg } from './llm'
import { makeRedactor } from './report'
import { PICK_SYSTEM, PLANNER_SYSTEM, today } from './prompts'
import { fieldLine, memoryText, profileText, snapshotText } from './serialize'
import { EMPTY_OPTION_RE, sameValue } from '../content/exec/match'
import { detach } from './cdp'
import { Editors, SUBMIT_RE, isEmpty } from './editors'
import { Repair } from './repair'

export interface RunCtx {
  tabId: number
  /** 本次运行使用的资料档案 */
  archiveId: string
  settings: Settings
  /** 本次运行的模型配置（设置页里填的接口） */
  models: { planner: ModelConfig; fast: ModelConfig }
  profile: Profile
  qa: QA[]
  files: StoredFile[]
  mem: SiteMemory
  abort: AbortController
  emit: (e: RunEvent) => void
  ask: (question: string, options?: string[], label?: string) => Promise<string>
  confirm: (items: ConfirmItem[]) => Promise<ConfirmDecision[]>
  /** 运行结束后收到本轮学到的站点经验（合并进本机保存的这个站点的经验） */
  saveSite?: (m: SiteMemory) => void
}

const sleep = (ms: number) => timing.span('sleep', `sleep ${ms}`, () => new Promise<void>((r) => setTimeout(r, ms)))
// 页面相关的调用都过一遍计时
const snapshotTab = (tabId: number, trusted: string) => timing.span('snapshot', 'snapshot', () => snapshotTab0(tabId, trusted), (s) => (s ? { fields: s.fields.length } : undefined))
const waitStable = (tabId: number, quiet?: number, max?: number) => timing.span('waitStable', `waitStable ${quiet ?? ''}/${max ?? ''}`, () => waitStable0(tabId, quiet, max))
const PHASE: Record<string, string> = { wait: '等待页面就绪', snapshot: '读取页面', upload: '上传附件', blocks: '补块', fill: '填写', repair: '修复', ask: '确认与回答' }

export class Run {
  snap!: FormSnapshot
  outcomes = new Map<string, FieldOutcome>()
  /** 本次已经上传过文件的字段（按标签）：重复上传会让站点重新解析、整页重新渲染 */
  uploaded = new Set<string>()
  /** 本轮模型新写的站点经验笔记 */
  newNotes: string[] = []
  profileTxt: string
  /** 一次编辑一条的编辑框流程 */
  ed: Editors
  constructor(readonly c: RunCtx) {
    this.profileTxt = profileText(c.profile, c.qa, c.files)
    this.ed = new Editors(this)
    this.fix = new Repair(this)
  }
  /** 修复阶段（工具调用循环） */
  fix: Repair
  waitStable() {
    return waitStable(this.c.tabId, 300, 3000)
  }

  get stopped() {
    return this.c.abort.signal.aborted
  }
  check() {
    if (this.stopped) throw new Error('已停止')
  }
  logs: string[] = []
  trace: { title: string; text: string }[] = []
  log(text: string, level: 'info' | 'warn' | 'error' | 'ai' = 'info') {
    this.logs.push(level === 'info' ? text : `[${level}] ${text}`)
    if (this.logs.length > 600) this.logs.shift()
    this.c.emit({ kind: 'log', text, level })
  }
  /** 记录原始材料（快照、规划原文、验证问题），写进诊断报告 */
  dbg(title: string, text: string) {
    this.trace.push({ title, text: text.slice(0, 60000) })
    if (this.trace.length > 80) this.trace.shift()
  }
  status(phase: string, text: string) {
    if (PHASE[phase]) timing.enter(PHASE[phase])
    this.c.emit({ kind: 'status', phase, text })
  }
  pushOutcomes() {
    this.c.emit({ kind: 'outcomes', outcomes: Array.from(this.outcomes.values()) })
    this.c.emit({ kind: 'usage', calls: usage.calls, inTok: usage.inTok, outTok: usage.outTok })
  }
  /** 页面动作（计时，按"操作 字段名"记录） */
  act(action: Action) {
    const label = this.field(action.ref)?.label ?? this.snap?.buttons.find((b) => b.ref === action.ref)?.text ?? action.ref
    return timing.span('act', `${action.op} ${label}`, () => act0(this.c.tabId, action, this.c.settings.trustedInput), (r) => (r ? { ok: r.ok, path: r.path, prof: r.prof } : undefined))
  }
  /** 等用户：单独计时，不算进实际用时 */
  ask(question: string, options?: string[], label?: string) {
    return timing.span('user', `ask ${label ?? ''}`, () => this.c.ask(question, options, label))
  }
  confirm(items: ConfirmItem[]) {
    return timing.span('user', `confirm ${items.length}`, () => this.c.confirm(items))
  }
  field(ref: string): FieldNode | undefined {
    return this.snap.fields.find((f) => f.ref === ref)
  }
  async snapshot() {
    this.snap = await snapshotTab(this.c.tabId, this.c.settings.trustedInput)
    return this.snap
  }
  fastCfg() {
    return this.c.models.fast
  }

  // ---------- 规划 ----------
  planNo = 0
  async plan(note = ''): Promise<FillPlan> {
    const back = timing.enter('规划')
    try {
      return await this.planInner(note)
    } finally {
      back()
    }
  }
  async planInner(note: string): Promise<FillPlan> {
    this.status('plan', '正在分析表单并规划填写…')
    const msgs: Msg[] = [
      { role: 'system', content: PLANNER_SYSTEM.replace('{{TODAY}}', today()) },
      { role: 'user', content: this.profileTxt + '\n\n' + memoryText(this.c.mem) + '\n\n# 当前页面表单\n' + snapshotText(this.snap, this.c.mem) + (note || this.badButtons.size || this.ed.note() ? '\n\n# 补充说明\n' + [note, this.ed.note(), this.badNote()].filter(Boolean).join('\n') : '') },
    ]
    this.dbg('规划输入：页面快照', snapshotText(this.snap, this.c.mem) + (note ? '\n\n# 补充说明\n' + note : ''))
    const raw = await chatJson<Partial<FillPlan>>(this.c.models.planner, msgs, { maxTokens: 8000, signal: this.c.abort.signal, tag: `plan#${++this.planNo}` })
    this.dbg('规划输出（模型原文）', JSON.stringify(raw, null, 1))
    const refs = new Set(this.snap.fields.map((f) => f.ref))
    const btns = new Set(this.snap.buttons.map((b) => b.ref))
    const plan: FillPlan = {
      addBlocks: (raw.addBlocks ?? [])
        .filter((b) => b && btns.has(b.ref) && b.times > 0)
        .map((b) => ({ ...b, key: this.btnKey(b.ref) }))
        .filter((b) => {
          const why = this.badButtons.get(this.ledgerKey(b.key))
          if (why) this.log(`不再点击${this.btnName(b.key)}：${why}`, 'warn')
          return !why
        }),
      actions: (raw.actions ?? []).filter((a) => a && refs.has(a.ref) && a.op),
      skip: raw.skip ?? [],
      questions: raw.questions ?? [],
      nextRef: raw.nextRef && btns.has(raw.nextRef) ? raw.nextRef : undefined,
      submitRef: raw.submitRef && btns.has(raw.submitRef) ? raw.submitRef : undefined,
    }
    // 编辑框的"保存这一条"按钮不是加块按钮：记下还要几条，由编辑框流程逐条填写、保存、新增
    plan.addBlocks = plan.addBlocks.filter((b) => !this.ed.takeAddBlock(b))
    // 已经是正确值、同时又被放进动作里的：不再执行一遍
    const correct = new Set(plan.skip.filter((x) => x.reason === 'already-correct').map((x) => x.ref))
    plan.actions = plan.actions.filter((a) => !correct.has(a.ref) && a.source !== 'already-correct')
    this.log(`规划完成：${plan.actions.length} 个动作，跳过 ${plan.skip.length}，补块 ${plan.addBlocks.reduce((n, b) => n + b.times, 0)}，待提问 ${plan.questions.length}`, 'ai')
    for (const s of plan.skip) {
      const f = this.field(s.ref)
      if (f && !this.outcomes.has(s.ref)) this.outcomes.set(s.ref, { ref: s.ref, label: f.label, section: f.section, status: s.reason === 'already-correct' ? 'already-correct' : 'skipped', attempts: 0, note: s.reason, actual: f.value })
    }
    return plan
  }

  // ---------- 执行 ----------
  async toAction(p: { ref: string; op: string; value?: unknown; fileId?: string }): Promise<Action> {
    if (p.op === 'upload') {
      const id = String(p.fileId ?? p.value ?? '')
      const meta = this.c.files.find((f) => f.id === id) ?? this.c.files.find((f) => f.kind === 'resume')
      const data = meta ? await store.fileData(meta.id) : null
      return { op: 'upload', ref: p.ref, file: meta && data ? { name: meta.name, mime: meta.mime, base64: data } : undefined }
    }
    let value = p.value as Action['value']
    if (p.op === 'check') value = value === true || value === 'true' || value === '是'
    return { op: p.op as Action['op'], ref: p.ref, value }
  }

  plannedValue(p: { op: string; value?: unknown; fileId?: string }) {
    if (p.op === 'upload') {
      const meta = this.c.files.find((f) => f.id === (p.fileId ?? p.value))
      return meta ? [meta.name] : undefined
    }
    if (p.op === 'cascade' && Array.isArray(p.value)) return p.value[p.value.length - 1]
    return p.value
  }

  /** 下拉没有完全一致的选项时：拿真实选项问一次快模型"选哪个最合适"，立刻重试（不进入慢的修复循环） */
  async exec(p0: PlanAction | { ref: string; op: string; value?: unknown; source?: string; generated?: boolean }): Promise<ActionResult> {
    let p = p0
    let r = await this.execOnce(p)
    // 动态表单：选了某项后后面的字段被重新渲染，ref 失效。重新读页面，按分区+名称/占位文字找回同一个字段再做一次
    if (!r.ok && /已失效/.test(r.error ?? '')) {
      const moved = await this.remap(p.ref)
      if (moved) {
        if (moved !== p.ref) {
          this.log(`「${this.field(moved)?.label ?? moved}」重新渲染过，换成新的 ${moved} 再填一次`)
          this.outcomes.delete(p.ref)
        }
        p = { ...p, ref: moved }
        r = await this.execOnce(p)
      }
    }
    if (r.ok || p.op !== 'select' || Array.isArray(p.value) || !r.observed || !/选项/.test(r.observed)) return r
    // 多列面板（级联）：前面的列是上级分类（常常只是内部代码），只从最后一列里选
    const cols = r.observed.replace(/^[^：]*：/, '').split(/第\d+列:\s*/).filter((x) => x.trim())
    // 不像下拉面板（例如很多列、每列只有一项——多半是误把页面导航当成了面板）：不拿它问模型，交给修复
    if (cols.length >= 3 && cols.every((c) => c.split('|').filter((x) => x.trim()).length <= 1)) {
      this.log(`「${this.field(p.ref)?.label ?? p.ref}」的面板选项看起来不像下拉选项，不自动选最接近的`, 'warn')
      return r
    }
    const options = (cols[cols.length - 1] ?? '')
      .split('|')
      .map((x) => x.replace(/^✓|\(禁用\)/g, '').trim())
      .filter((x) => x && x.length <= 60 && !/^(取消|确定|确认|删除|清空已选)$/.test(x) && !EMPTY_OPTION_RE.test(x))
    if (options.length < 1 || options.length > 120) return r
    const label = this.field(p.ref)?.label ?? p.ref
    try {
      const res = await chat(this.fastCfg(), [
        { role: 'system', content: PICK_SYSTEM },
        { role: 'user', content: `字段：${label}\n目标值：${String(p.value)}\n真实选项：\n${options.map((o) => '- ' + o).join('\n')}` },
      ], { maxTokens: 60, temperature: 0, signal: this.c.abort.signal, tag: `pick ${label}` })
      const pick = res.text.trim().replace(/^[-\s"「]+|["」\s]+$/g, '')
      const chosen = options.find((o) => o === pick) ?? options.find((o) => o.replace(/\s+/g, '') === pick.replace(/\s+/g, ''))
      if (!chosen) return r
      this.log(`「${label}」没有「${p.value}」，改选最接近的「${chosen}」`, 'ai')
      return await this.execOnce({ ...p, value: chosen.replace(/\s+/g, ' '), source: `最接近「${p.value}」` })
    } catch {
      return r
    }
  }

  /** 失效的 ref 找回：先看页面重新读一遍后 ref 是否已经绑到新元素上；否则在同一分区里找同种类、名称或占位文字相同、还没处理过的唯一字段 */
  async remap(ref: string): Promise<string | undefined> {
    const old = this.field(ref)
    if (!old) return undefined
    await waitStable(this.c.tabId, 300, 3000)
    await this.snapshot()
    if (this.field(ref)) return ref
    const same = (a?: string, b?: string) => !!a && !!b && a === b
    const cands = this.snap.fields.filter((f) => (f.section ?? '') === (old.section ?? '') && f.hint === old.hint && !this.outcomes.has(f.ref) &&
      (same(f.label, old.label) || same(f.placeholder, old.placeholder) || same(f.placeholder, old.label) || same(f.label, old.placeholder)))
    return cands.length === 1 ? cands[0].ref : undefined
  }

  /** 回读值是否算对：等于计划值，或等于执行时实际选中的那一项（没有完全一致的选项、选了最接近的） */
  accepts(o: FieldOutcome, value: unknown) {
    return sameValue(o.planned, value) || (!!o.picked && sameValue(o.picked, value))
  }
  /** 改判为成功：按选中的那一项记计划值，并注明资料原文 */
  adopt(o: FieldOutcome, value: unknown) {
    if (o.picked && !sameValue(o.planned, value)) {
      o.note = `资料写的是「${Array.isArray(o.planned) ? o.planned.join('/') : o.planned}」，选了最接近的「${o.picked}」`
      o.planned = o.picked
    } else if (o.status === 'failed') o.note = undefined
    o.actual = value
    if (o.status === 'failed') o.status = 'filled'
  }
  /** 执行时判为失败、但页面上现在的值已经对了的（组件提交值慢，当时回读是空的）：改判为成功 */
  recheckFailed(section?: string) {
    for (const o of this.outcomes.values()) {
      if (o.status !== 'failed' || o.planned === undefined || (section !== undefined && (o.section ?? '') !== section)) continue
      const f = this.field(o.ref)
      if (f && !f.error && this.accepts(o, f.value)) this.adopt(o, f.value)
    }
    this.pushOutcomes()
  }

  async execOnce(p: PlanAction | { ref: string; op: string; value?: unknown; source?: string; generated?: boolean }): Promise<ActionResult> {
    this.check()
    const f = this.field(p.ref)
    if (p.op === 'upload' && f && this.uploaded.has(f.label)) return { ok: true, ref: p.ref, path: 'skip-duplicate' }
    const action = await this.toAction(p)
    if (action.op === 'upload' && !action.file) return { ok: false, ref: p.ref, error: '本机没有保存可上传的文件' }
    const t0 = Date.now()
    const r = await this.act(action)
    const ms = Date.now() - t0
    const prev = this.outcomes.get(p.ref)
    const planned = this.plannedValue(p)
    // 下拉里没有完全一致的、选了最接近的选项：回读等于选中的那一项也算成功
    const picked = r.path?.match(/^picked:([^|]*)/)?.[1] ?? r.path?.match(/最接近的「([^」]+)」/)?.[1]
    const ok = r.ok && (r.readback === undefined || sameValue(planned, r.readback) || (!!picked && sameValue(picked, r.readback)))
    // 选了最接近的选项：以后验证就拿选中的那一项比对，并注明资料原文
    const closest = ok && !!picked && !sameValue(planned, r.readback)
    this.outcomes.set(p.ref, {
      ref: p.ref,
      label: f?.label ?? prev?.label ?? p.ref,
      section: f?.section ?? prev?.section,
      planned: closest ? picked : planned ?? prev?.planned,
      actual: r.readback,
      status: ok ? ((p as PlanAction).generated || prev?.status === 'generated' ? 'generated' : 'filled') : 'failed',
      source: (p as PlanAction).source ?? prev?.source,
      op: p.op,
      attempts: (prev?.attempts ?? 0) + 1,
      // 实际点中的那一项（回读当时没跟上时，验证阶段拿它比对）
      picked: picked ?? prev?.picked,
      note: ok ? (closest ? `资料写的是「${Array.isArray(planned) ? planned.join('/') : planned}」，选了最接近的「${picked}」` : undefined) : r.error,
    })
    const label = f?.label ?? p.ref
    if (p.op === 'upload' && ok && f) this.uploaded.add(f.label)
    this.log(
      `${ok ? '✓' : '✗'} ${label}${planned !== undefined ? ' ← ' + JSON.stringify(planned) : ''}${ok ? '' : '：' + (r.error ?? '回读不一致 ' + JSON.stringify(r.readback))}${ms >= 500 ? `（${(ms / 1000).toFixed(1)}s）` : ''}${!ok && r.observed ? '\n    现场：' + r.observed.slice(0, 240) : ''}`,
      ok ? 'info' : 'warn',
    )
    if (!ok && r.observed) this.observed.set(p.ref, r.observed)
    this.pushOutcomes()
    return r
  }

  /** 资料里没有答案、等候选人确认的推导值：在保存编辑框之前就问，确认后立刻填 */
  async confirmNow(list: PlanAction[]) {
    if (!list.length) return
    const items: ConfirmItem[] = list.map((a) => ({ key: a.ref, label: this.field(a.ref)?.label ?? a.ref, value: Array.isArray(a.value) ? a.value.join('/') : String(a.value ?? ''), reason: a.reason }))
    this.status('ask', `保存这一条之前，有 ${items.length} 个 AI 推导的答案需要你确认`)
    const decisions = await this.confirm(items)
    this.status('fill', '填写中…')
    for (const a of list) {
      const d = decisions.find((x) => x.key === a.ref)
      const label = this.field(a.ref)?.label ?? a.ref
      if (!d?.use) {
        const f = this.field(a.ref)
        if (f) this.outcomes.set(a.ref, { ref: a.ref, label: f.label, section: f.section, planned: a.value, status: 'skipped', attempts: 0, op: a.op, note: '你没有采用 AI 推导的答案' })
        continue
      }
      const edited = d.value !== (Array.isArray(a.value) ? a.value.join('/') : String(a.value ?? ''))
      const value = edited ? (Array.isArray(a.value) || a.op === 'cascade' ? d.value.split('/') : d.value) : a.value
      await store.addQa(label, d.value, 'user', this.c.archiveId)
      await this.exec({ ...a, value, inferred: false, source: '已确认的推导' })
    }
    this.c.qa = await store.qa(this.c.archiveId)
    this.profileTxt = profileText(this.c.profile, this.c.qa, this.c.files)
  }

  /** 依次执行；"下拉是空的"（多半要先填它依赖的字段）的，等其他字段填完再试一次 */
  async execAll(actions: PlanAction[]) {
    const empty: PlanAction[] = []
    for (const a of actions) {
      const r = await this.exec(a)
      if (!r.ok && r.observed) this.observed.set(a.ref, r.observed)
      if (!r.ok && r.path === 'empty') empty.push(a)
      if (a.op === 'upload' && r.path !== 'skip-duplicate') {
        await waitStable(this.c.tabId, 1500, 15000)
        await this.snapshot()
      }
    }
    for (const a of empty) {
      this.log(`「${this.field(a.ref)?.label ?? a.ref}」刚才下拉是空的，其他字段填完后再试一次`)
      const r = await this.exec(a)
      if (!r.ok && r.observed) this.observed.set(a.ref, r.observed)
    }
  }

  // ---------- 重复块 ----------
  /** 本次运行每个添加按钮成功加出的块数（同一个按钮最多 15 块） */
  blockLedger = new Map<string, number>()
  /** 不能再点的添加按钮 → 原因（把块加到了别的分区 / 填完当前块后仍加不出） */
  badButtons = new Map<string, string>()
  /** 交给修复阶段的额外说明（例如哪个分区被误加了空块） */
  repairHints: string[] = []

  btnKey(ref: string): BlockKey {
    const b = this.snap.buttons.find((x) => x.ref === ref)!
    const same = this.snap.buttons.filter((x) => x.text === b.text && x.section === b.section).sort((p, q) => p.order - q.order)
    return { ref, text: b.text, section: b.section, nth: Math.max(0, same.findIndex((x) => x.ref === ref)) }
  }
  /** 按 ref 找；ref 失效时按"分区 + 文字 + 同名序号"找。绝不退回到页面上第一个同名按钮 */
  findBtn(k: BlockKey) {
    return this.snap.buttons.find((x) => x.ref === k.ref && x.text === k.text) ??
      this.snap.buttons.filter((x) => x.text === k.text && x.section === k.section).sort((p, q) => p.order - q.order)[k.nth]
  }
  ledgerKey(k: BlockKey) {
    return `${k.section ?? ''}|${k.text}|${k.nth}`
  }
  btnName(k: BlockKey) {
    return `「${k.section ? k.section + ' 的 ' : ''}${k.text}」`
  }
  badNote() {
    if (!this.badButtons.size) return ''
    return '以下添加按钮本次已经确认不能再点，不要放进 addBlocks：' + Array.from(this.badButtons, ([k, why]) => `${k.split('|').slice(0, 2).join(' 的 ')}（${why}）`).join('；')
  }

  /** 点一次添加按钮，并核对新块确实出现在按钮所在的分区 */
  async addBlock(k: BlockKey): Promise<{ ok: boolean; wrong?: string; why?: string }> {
    const before = new Set(this.snap.fields.map((f) => f.ref))
    const sections0 = new Set(this.snap.fields.map((f) => f.section ?? ''))
    for (const trusted of [false, true]) {
      const b = this.findBtn(k)
      if (!b) return { ok: false, why: '页面上找不到这个按钮了' }
      await this.act({ op: 'click', ref: b.ref, trusted })
      await waitStable(this.c.tabId, 300, 3000)
      await this.snapshot()
      const added = this.snap.fields.filter((f) => !before.has(f.ref))
      // 新控件里带着刚填进去的值 = 表单只是重新渲染了（例如保存时校验没通过），不是新的空白块。
      // 绝不能当成新块去填下一条资料，否则会把上一条覆盖掉
      // 只和这个按钮所在分区里刚填过的值比（别的分区里同样的值，例如两段经历都写"浙江大学"，不能当成"带着刚填的值"）
      const mine = new Set([...this.outcomes.values()].filter((o) => (o.status === 'filled' || o.status === 'generated') && (o.section ?? '') === (k.section ?? '')).flatMap((o) => [o.actual, o.planned]).flat().filter((v) => typeof v === 'string' && v.trim().length >= 2).map((v) => String(v).replace(/\s+/g, '')))
      const carried = added.filter((f) => (f.section ?? '') === (k.section ?? '')).filter((f) => [f.value].flat().some((v) => typeof v === 'string' && mine.has(v.replace(/\s+/g, ''))))
      if (added.length && (carried.length >= 2 || (carried.length >= 1 && carried.length * 2 >= added.length))) {
        this.dbg(`添加块 ${this.btnName(k)}（只是重新渲染）`, `按钮 ${b.ref}，新出现 ${added.length} 个字段，其中 ${carried.length} 个带着刚填的值：\n` + carried.map((f) => fieldLine(f)).join('\n'))
        return { ok: false, why: '点击后表单只是重新渲染（新控件里带着刚填的值），不是新的空白块' }
      }
      if (added.length) {
        this.dbg(`添加块 ${this.btnName(k)}`, `按钮 ${b.ref}，新出现 ${added.length} 个字段：\n` + added.map((f) => fieldLine(f) + '   §' + (f.section ?? '')).join('\n'))
        // 新字段全部落在同一个原本就存在的、别的分区里 = 点到了别的分区的按钮（或站点把块加错了地方）。
        // 散在好几个"分区"里的不算：那是页面把每个字段的标题都认成了分区（"开始时间""学历"各成一区）
        const elsewhere = added.filter((f) => (f.section ?? '') !== (k.section ?? '') && sections0.has(f.section ?? ''))
        const dest = new Set(elsewhere.map((f) => f.section ?? ''))
        if (k.section && elsewhere.length === added.length && dest.size === 1) return { ok: false, wrong: elsewhere[0].section ?? '(无分区)' }
        return { ok: true }
      }
      if (this.c.settings.trustedInput === 'off') break
    }
    return { ok: false, why: '站点可能要求先填完当前块' }
  }

  /** 带账本的加块：返回 ok / blocked（没加出来，可能要先填完当前块）/ bad（不能再点） */
  async tryAdd(k: BlockKey, why?: string, retry = false): Promise<'ok' | 'blocked' | 'bad'> {
    const lk = this.ledgerKey(k)
    if (this.badButtons.has(lk)) return 'bad'
    const n = this.blockLedger.get(lk) ?? 0
    if (n >= 15) {
      this.badButtons.set(lk, '本次已经用它加了 15 块')
      return 'bad'
    }
    this.log(`点击${this.btnName(k)}${why ? '（' + why + '）' : ''}`)
    const r = await this.addBlock(k)
    if (r.ok) {
      this.blockLedger.set(lk, n + 1)
      return 'ok'
    }
    if (r.wrong) {
      this.badButtons.set(lk, `点了它，新块却出现在「${r.wrong}」`)
      this.log(`点击${this.btnName(k)}后新块出现在「${r.wrong}」，不是「${k.section}」，停止点击这个按钮`, 'warn')
      this.repairHints.push(`「${r.wrong}」分区被误加了 1 块空块（本来要给「${k.section}」加块）：点这块里的删除按钮把它删掉，不要填。`)
      return 'bad'
    }
    if (retry || r.why?.includes('重新渲染')) {
      this.badButtons.set(lk, r.why?.includes('重新渲染') ? '点了它只是重新渲染当前这一条，不会新增空白块' : '填完当前块后仍然加不出新块')
      this.log(`${this.btnName(k)}：${r.why}，不再点击它`, 'warn')
      return 'bad'
    }
    this.log(`点击${this.btnName(k)}后没有新增块（${r.why}），改为填完一块再加一块`, 'warn')
    return 'blocked'
  }

  async click(ref: string) {
    await this.act({ op: 'click', ref })
  }

  // ---------- 验证 ----------
  async verify(): Promise<string[]> {
    const back = timing.enter('验证')
    try {
      return await this.verifyInner()
    } finally {
      back()
    }
  }
  async verifyInner(): Promise<string[]> {
    await waitStable(this.c.tabId, 300, 3000)
    await this.snapshot()
    const issues: string[] = []
    for (const o of this.outcomes.values()) {
      if (o.planned === undefined || o.status === 'skipped' || o.status === 'asked' || o.status === 'pending') continue
      if (o.op === 'upload' && o.status === 'filled') continue // 上传后站点常把控件换掉，信任执行时的结果
      const f = this.field(o.ref)
      if (!f) {
        // ref 失效后，同一个值已经在重新渲染出来的新字段上填好了：旧的那条不算失败
        const done = o.status === 'failed' && /已失效/.test(o.note ?? '') && [...this.outcomes.values()].some((x) => x !== o && (x.status === 'filled' || x.status === 'generated') && (x.section ?? '') === (o.section ?? '') && JSON.stringify(x.planned) === JSON.stringify(o.planned))
        if (done) this.outcomes.delete(o.ref)
        continue
      }
      o.actual = f.value
      const ok = this.accepts(o, f.value) && !f.error
      if (!ok) {
        o.status = 'failed'
        issues.push(`${fieldLine(f)}\n   计划值=${JSON.stringify(o.planned)}；${o.note ? '执行反馈：' + o.note : '回读不一致'}`)
      } else this.adopt(o, f.value)
    }
    for (const f of this.snap.fields) {
      const o = this.outcomes.get(f.ref)
      const empty = isEmpty(f.value)
      if (!o && f.required && empty && !f.disabled && !this.queuedAsk.has(f.ref) && !this.askedRefs.has(f.ref)) issues.push(`${fieldLine(f)}\n   新出现/未处理的必填字段`)
      else if (o && f.error && !issues.some((i) => i.startsWith(f.ref))) issues.push(`${fieldLine(f)}\n   页面报错`)
    }
    this.pushOutcomes()
    return issues
  }

  // ---------- 修复（工具调用循环） ----------
  observed = new Map<string, string>()
  /** 排在最后统一问候选人的字段（规划给出的 questions）：验证和修复都不碰它们 */
  queuedAsk = new Set<string>()
  /** 本次运行已经问过的字段 → 回答了/跳过了。同一个字段本次只问一次 */
  askedRefs = new Map<string, 'answered' | 'skipped'>()
  askedQuestions = new Set<string>()
  /** 记下这些字段本次已经问过（跳过的标成"你跳过了"） */
  markAsked(refs: string[], ans: string) {
    for (const r of refs) {
      this.askedRefs.set(r, ans ? 'answered' : 'skipped')
      this.queuedAsk.delete(r)
      const f = this.field(r)
      if (!ans && f) this.outcomes.set(r, { ref: r, label: f.label, section: f.section, status: 'skipped', attempts: 0, note: '你跳过了' })
    }
    this.pushOutcomes()
  }

  async remember(q: string, a: string) {
    await store.addQa(q, a, 'user', this.c.archiveId)
    this.c.qa = await store.qa(this.c.archiveId)
    this.profileTxt = profileText(this.c.profile, this.c.qa, this.c.files)
  }

  // ---------- 一页 ----------
  async fillPage(): Promise<{ nextRef?: string; submitRef?: string }> {
    this.status('snapshot', '读取页面表单…')
    await this.snapshot()
    if (!this.snap.fields.length) {
      for (let i = 0; i < 10 && !this.snap.fields.length; i++) {
        await sleep(1000)
        await this.snapshot()
      }
      if (!this.snap.fields.length) {
        this.log('当前页面没有发现表单字段', 'warn')
        return {}
      }
    }
    this.log(`读到 ${this.snap.fields.length} 个字段、${this.snap.buttons.length} 个按钮`)
    let plan = await this.plan()

    // 1. 先传简历，让站点自己解析回填
    const uploads = plan.actions.filter((a) => a.op === 'upload')
    if (uploads.length) {
      this.status('upload', '先上传附件，等待站点解析…')
      const before = JSON.stringify(this.snap.fields.map((f) => f.value))
      for (const u of uploads) await this.exec(u)
      await waitStable(this.c.tabId, 1500, 20000)
      await this.snapshot()
      const changed = this.snap.fields.filter((f, i) => JSON.stringify(f.value) !== JSON.stringify(JSON.parse(before)[i])).length
      if (changed >= 3) {
        this.log(`站点根据简历回填了 ${changed} 个字段，重新规划`)
        plan = await this.plan('附件已上传，站点已自动回填部分字段；修正错误的、补全空的，不要再上传。站点回填通常只回填了每类经历的一部分：照样逐类核对资料条数和页面块数，不够就 addBlocks。')
      }
      plan.actions = plan.actions.filter((a) => a.op !== 'upload' || !uploads.some((u) => u.ref === a.ref))
    }

    // 2. 补齐重复块。每点一次都核对块是否真的加出来了；
    //    很多站点要求"先填完当前块才能再添加"，那就改成填一块、加一块
    const blocked: { key: BlockKey; remaining: number }[] = []
    for (let pass = 0; pass < 2 && plan.addBlocks.length; pass++) {
      this.status('blocks', '补齐重复块…')
      for (const b of plan.addBlocks) {
        const times = Math.min(b.times, 15)
        for (let i = 0; i < times; i++) {
          const r = await this.tryAdd(b.key!, b.why)
          if (r === 'blocked') blocked.push({ key: b.key!, remaining: times - i })
          if (r !== 'ok') break
        }
      }
      await this.snapshot()
      plan = await this.plan(pass === 0 ? '已按你的 addBlocks 补齐了块，现在为所有块生成动作；除非块数仍然不够，否则 addBlocks 留空。' : '块已补齐，addBlocks 必须留空。')
      if (blocked.length) break // 加不出来的块在填写后再加，不在这里反复规划
    }

    // 3. 批量执行（文档顺序）
    this.status('fill', '填写中…')
    const order = new Map(this.snap.fields.map((f) => [f.ref, f.order]))
    const sorted = plan.actions.sort((a, b) => (order.get(a.ref) ?? 0) - (order.get(b.ref) ?? 0))
    const inferred = sorted.filter((a) => a.inferred && !a.generated && a.op !== 'upload')
    await this.execAll(sorted.filter((x) => !inferred.includes(x)))
    // 3a. 一次编辑一条的编辑框：保存这一条，资料里还有就新增下一条接着填
    if (this.ed.sections().length) await this.ed.run(inferred, plan.questions)
    // 3b. 刚才加不出来的块：现在当前块已经填好，逐块添加并填写
    for (const b of blocked) {
      for (let i = 0; i < b.remaining && !this.stopped; i++) {
        const r = await this.tryAdd(b.key, undefined, true)
        if (r !== 'ok') {
          this.log(`${this.btnName(b.key)}仍然加不出新块，剩下 ${b.remaining - i} 块没有添加`, 'warn')
          break
        }
        this.log(`已添加一块（${b.key.section ?? b.key.text}），填写这一块`)
        const p = await this.plan(`刚点击${this.btnName(b.key)}新增了一块空白块。只为这块新出现的空块（以及同类里仍为空的块）生成动作，按资料里的下一条填写；其他字段不要动，addBlocks 留空。`)
        for (const a of p.actions.filter((x) => x.op !== 'upload')) {
          if (a.inferred && !a.generated) { inferred.push(a); continue }
          const r = await this.exec(a)
          if (!r.ok && r.observed) this.observed.set(a.ref, r.observed)
        }
        plan.questions.push(...p.questions)
      }
    }
    // 加块后重新规划会把同一个问题、同一个推导再给一遍：按字段去重（推导保留最后一次）
    {
      const byRef = new Map(inferred.map((a) => [a.ref, a] as const))
      inferred.splice(0, inferred.length, ...byRef.values())
      const seenRef = new Set<string>()
      const seenQ = new Set<string>()
      plan.questions = plan.questions.filter((q) => {
        const fresh = q.refs.length ? q.refs.some((r) => !seenRef.has(r)) : !seenQ.has(q.question)
        q.refs.forEach((r) => seenRef.add(r))
        seenQ.add(q.question)
        return fresh
      })
    }
    for (const a of inferred) {
      const f = this.field(a.ref)
      if (f) this.outcomes.set(a.ref, { ref: a.ref, label: f.label, section: f.section, planned: a.value, status: 'pending', attempts: 0, op: a.op, note: `AI 推导：${a.reason ?? ''}，待你确认` })
    }
    this.pushOutcomes()

    // 4. 验证 + 修复：先把自己能解决的都解决，再打扰用户
    //    排在第 5 步统一问的字段不交给修复（否则修复会自己再问一遍）
    for (const q of plan.questions) for (const r of q.refs) if (!this.askedRefs.has(r)) this.queuedAsk.add(r)
    this.fix.nextRefHint = plan.nextRef
    let issues = await this.verify()
    this.dbg('验证：待修复问题', issues.join('\n') || '(无)')
    if (issues.length || this.repairHints.length) {
      this.log(`有 ${issues.length} 处需要修复`)
      await this.fix.run(issues)
    }
    // 修复前推迟了保存的编辑框：现在保存
    if (this.ed.deferredSave.size) await this.ed.run(inferred, plan.questions, true)

    // 5. 资料里没有的问题 + AI 推导的答案：一次性全部列出，用户按任意顺序处理
    if (plan.questions.length || inferred.length) {
      this.status('ask', `需要你处理：${inferred.length ? inferred.length + ' 个 AI 推导的答案待确认' : ''}${inferred.length && plan.questions.length ? '，' : ''}${plan.questions.length ? plan.questions.length + ' 个问题待回答' : ''}`)
      const confirming = (async () => {
        if (!inferred.length) return
        const items: ConfirmItem[] = inferred.map((a) => ({ key: a.ref, label: this.field(a.ref)?.label ?? a.ref, value: Array.isArray(a.value) ? a.value.join('/') : String(a.value ?? ''), reason: a.reason }))
        const decisions = await this.confirm(items)
        for (const a of inferred) {
          const d = decisions.find((x) => x.key === a.ref)
          const label = this.field(a.ref)?.label ?? a.ref
          if (!d?.use) {
            const o = this.outcomes.get(a.ref)
            if (o) { o.status = 'skipped'; o.note = '你没有采用 AI 推导的答案' }
            continue
          }
          const edited = d.value !== (Array.isArray(a.value) ? a.value.join('/') : String(a.value ?? ''))
          const value = edited ? (Array.isArray(a.value) || a.op === 'cascade' ? d.value.split('/') : d.value) : a.value
          await store.addQa(label, d.value, 'user', this.c.archiveId) // 确认过的推导存进问答库，以后不再询问
          this.check()
          await this.exec({ ...a, value, inferred: false, source: '已确认的推导' })
        }
        this.c.qa = await store.qa(this.c.archiveId)
        this.profileTxt = profileText(this.c.profile, this.c.qa, this.c.files)
      })()
      await Promise.all([confirming, ...
        plan.questions
          .filter((q) => !(q.refs.length && q.refs.every((r) => this.askedRefs.has(r))) && !this.askedQuestions.has(q.question))
          .map(async (q) => {
            this.askedQuestions.add(q.question)
            const labels = q.refs.map((r) => this.field(r)?.label).filter(Boolean).join('、')
            const ans = await this.ask(q.question, q.options, labels)
            this.markAsked(q.refs, ans)
            for (const r of q.refs) {
              const f = this.field(r)
              if (f && ans) this.outcomes.set(r, { ref: r, label: f.label, section: f.section, status: 'pending', attempts: 0, note: `你的回答：${ans}` })
            }
            if (ans) await this.remember(q.question, ans)
          }),
      ])
      this.check()
      issues = await this.verify()
      for (const o of this.outcomes.values()) {
        const f = o.status === 'pending' ? this.field(o.ref) : undefined
        if (f) issues.push(`${fieldLine(f)}\n   候选人刚回答了：${o.note}，请据此填写`)
      }
      if (issues.length) await this.fix.run(issues)
    }
    await this.verify()
    for (const o of this.outcomes.values()) if (o.status === 'pending') o.status = 'failed'
    this.pushOutcomes()
    const nb = this.snap.buttons.find((b) => b.ref === plan.nextRef)
    if (nb && this.ed.isSaveButton(nb.ref)) {
      this.log(`「${nb.text}」是「${nb.section ?? ''}」的保存按钮，保存已经由上面的流程处理，不当作下一步再点`)
      return { submitRef: plan.submitRef }
    }
    return { nextRef: plan.nextRef, submitRef: plan.submitRef }
  }

  async run() {
    usage.reset()
    timing.reset()
    await ensureInjected(this.c.tabId)
    await resetDumps(this.c.tabId) // 导出的现场只包含本次运行
    this.status('wait', '等待页面就绪…')
    await waitStable(this.c.tabId, 400, 6000)
    for (let step = 0; step < 12; step++) {
      const { nextRef, submitRef } = await this.fillPage()
      if (!nextRef || this.stopped) break
      const btn = this.snap.buttons.find((b) => b.ref === nextRef)
      if (!btn || nextRef === submitRef || SUBMIT_RE.test(btn.text)) break
      timing.enter('翻页')
      this.log(`进入下一步：点击「${btn.text}」`)
      const before = this.snap.fields.map((f) => f.label).join('|')
      await this.click(nextRef)
      await sleep(800)
      await waitStable(this.c.tabId, 600, 10000)
      await this.snapshot()
      if (this.snap.fields.map((f) => f.label).join('|') === before) {
        this.log('点击下一步后页面没有变化（可能有校验未通过），停在这里', 'warn')
        break
      }
    }
  }

  /** 本轮学到的站点经验（存本机，按站点合并）：字段映射不带值；含个人资料的笔记不保存 */
  learn(): SiteMemory {
    const list = [...this.outcomes.values()]
    const fieldMap = list
      .filter((o) => o.status === 'filled' || o.status === 'generated')
      .map((o) => ({ label: o.label, section: o.section, source: o.source, op: o.status === 'generated' ? 'write' : 'fill' }))
    const optionCache: Record<string, string[]> = {}
    for (const [ref, ob] of this.observed) {
      const label = this.outcomes.get(ref)?.label
      const opts = ob.match(/面板选项：(.*)/)?.[1]
      if (label && opts && !opts.includes('第2列')) optionCache[label] = opts.split(' | ').map((x) => x.replace(/^✓/, '')).slice(0, 60)
    }
    const redact = makeRedactor({ profile: this.c.profile, qa: this.c.qa, files: this.c.files, outcomes: list, snap: this.snap, observed: [...this.observed.values()] })
    const notes = this.newNotes.filter((n) => redact(n) === n)
    return { ...emptySite(this.c.mem.origin), fieldMap, optionCache, notes }
  }
}

export async function runAgent(c: RunCtx) {
  const run = new Run(c)
  // 多步表单填完时网址可能变了：投递记录按开始填写的那一页记
  const tab = await chrome.tabs.get(c.tabId).catch(() => null)
  try {
    await run.run()
  } catch (e) {
    c.emit({ kind: 'log', text: (e as Error).message, level: 'error' })
  } finally {
    await detach(c.tabId)
  }
  const list = Array.from(run.outcomes.values())
  const n = (s: string) => list.filter((o) => o.status === s).length
  if (c.saveSite && run.snap) {
    try {
      c.saveSite(run.learn())
    } catch {}
  }
  watchEdits(c.tabId, list.filter((o) => o.status === 'filled' || o.status === 'generated').map((o) => ({ ref: o.ref, label: o.label, value: o.actual })))
  for (const line of timing.summaryLines()) run.log(line)
  const tt = timing.totals()
  const summary = `完成：已填 ${n('filled')}，AI 撰写 ${n('generated')}，已正确 ${n('already-correct')}，失败 ${n('failed')}，跳过 ${n('skipped')} · 用时 ${Math.round(tt.activeMs / 1000)}s${tt.userMs >= 1000 ? `（另等你 ${Math.round(tt.userMs / 1000)}s）` : ''}`
  const url = tab?.url ?? run.snap?.url
  if (url && /^https?:/.test(url) && list.length) await store.recordApplication({ url, title: tab?.title || run.snap?.title || '', archiveId: c.archiveId, outcomes: list })
  c.emit({ kind: 'outcomes', outcomes: list })
  c.emit({ kind: 'done', summary })
}
