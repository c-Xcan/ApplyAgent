// 修复阶段：把验证发现的问题连同现场交给模型，模型用工具（fill/select/cascade/open/click…）逐个处理。
// 从 agent.ts 拆出来；页面操作、提问、记录都调回 Run。
import type { Action, ActionResult, FieldNode } from '../shared/types'
import type { Run } from './agent'
import { chat, type Msg, type ToolCall } from './llm'
import { REPAIR_SYSTEM, TOOLS, today } from './prompts'
import { memoryText, snapshotText } from './serialize'
import { SUBMIT_RE, isEmpty } from './editors'

export class Repair {
  constructor(private r: Run) {}

  /** 交给修复的待处理字段所在分区：修复阶段只发这些分区 + 仍为空的必填字段，不发整页 */
  repairSections = new Set<string>()

  /** 修复用的精简快照：只列待处理字段所在分区，以及仍为空的必填字段 */
  focusSnapshot(): string {
    const s = this.r.snap
    const empty = (f: FieldNode) => f.required && isEmpty(f.value) && !f.disabled
    const keep = (sec?: string) => this.repairSections.has(sec ?? '')
    const fields = s.fields.filter((f) => keep(f.section) || empty(f))
    const buttons = s.buttons.filter((b) => keep(b.section) || SUBMIT_RE.test(b.text) || b.ref === this.nextRefHint)
    const rest = s.fields.length - fields.length
    return snapshotText({ ...s, fields, buttons }, this.r.c.mem) + (rest > 0 ? `\n\n（为了简洁，只列出了待处理字段所在的分区和仍为空的必填字段；其余 ${rest} 个字段已填好。需要整页时调用 snapshot 并传 full=true）` : '')
  }
  nextRefHint?: string
  doNotAskText() {
    const refs = [...new Set([...this.r.queuedAsk, ...this.r.askedRefs.keys()])]
    if (!refs.length) return ''
    return '\n\n# 这些字段会单独问候选人、或候选人已经跳过：不要处理，也不要 ask_user\n' + refs.map((r) => `${r}(${this.r.field(r)?.label ?? ''}${this.r.askedRefs.get(r) === 'skipped' ? '，已跳过' : ''})`).join('、')
  }

  repairNo = 0
  async run(issues: string[]) {
    const s = this.r.c.settings
    // 待处理字段所在分区（以及修复提示里提到的分区）
    this.repairSections = new Set(issues.map((x) => this.r.field(x.split(/\s/)[0])?.section ?? '').concat(this.r.repairHints.flatMap((h) => [...h.matchAll(/「([^」]+)」/g)].map((m) => m[1]))))
    const msgs: Msg[] = [
      { role: 'system', content: REPAIR_SYSTEM.replace('{{TODAY}}', today()) },
      {
        role: 'user',
        content:
          this.r.profileTxt + '\n\n' + memoryText(this.r.c.mem) + '\n\n# 当前页面表单\n' + this.focusSnapshot() + this.doNotAskText() +
          '\n\n# 提示\n- 互不相关的控件可以在同一轮里同时调用多个工具，减少来回。' +
          (() => {
            const waiting = Array.from(this.r.outcomes.values()).filter((o) => o.status === 'pending' && o.op)
            return waiting.length ? '\n\n# 这些字段正在等候选人确认 AI 推导的答案，不要处理：' + waiting.map((o) => `${o.ref}(${o.label})`).join('、') : ''
          })() +
          (this.r.repairHints.length ? '\n\n# 先处理\n' + this.r.repairHints.splice(0).map((h) => '- ' + h).join('\n') : '') +
          '\n\n# 需要处理的问题\n' + issues.map((x, i) => {
            const ref = x.split(/\s/)[0]
            const ob = this.r.observed.get(ref)
            return `${i + 1}. ${x}${ob ? '\n   现场：' + ob.replace(/\n/g, '\n   ') : ''}`
          }).join('\n'),
      },
    ]
    let calls = 0
    for (let round = 0; round < s.maxRepairRounds; round++) {
      this.r.check()
      this.r.status('repair', `修复中（第 ${round + 1} 轮）…`)
      const r = await chat(this.r.fastCfg(), msgs, { tools: TOOLS, maxTokens: 4000, signal: this.r.c.abort.signal, tag: `repair#${++this.repairNo}` })
      if (r.text) this.r.log(r.text.slice(0, 300), 'ai')
      msgs.push({ role: 'assistant', content: r.text, toolCalls: r.toolCalls })
      if (!r.toolCalls.length) break
      let finished = false
      for (const call of r.toolCalls) {
        calls++
        const out = await this.tool(call)
        if (call.name === 'finish') finished = true
        msgs.push({ role: 'tool', toolCallId: call.id, content: out })
      }
      if (finished || calls > 80) break
    }
  }

  /** 修复阶段：同一个动作+同样的值 → 失败次数 */
  failedTries = new Map<string, number>()
  /** 修复阶段 observe/open 的上一次结果：同一个控件现场没变就不再整段返回，避免模型反复查看 */
  seen = new Map<string, { sig: string; n: number }>()

  /** 最近用 open 打开的字段：之后 click 面板里的节点（n 开头的 ref），选中的是这个字段的值 */
  openedField?: string
  /** 在打开的面板里点了一项之后：字段有了值、没有报错，就按页面上的值记为已填（不然结果里还留着原来那个失败的计划值） */
  async pickedInPanel(ref: string): Promise<string> {
    await this.r.waitStable()
    await this.r.snapshot()
    const f = this.r.field(ref)
    const o = this.r.outcomes.get(ref)
    if (!f || !o || o.status !== 'failed' || isEmpty(f.value) || f.error || JSON.stringify(f.value) === JSON.stringify(o.actual)) return ''
    Object.assign(o, { planned: f.value, actual: f.value, picked: undefined, status: 'filled', note: '修复时在面板里点选' })
    this.openedField = undefined
    this.r.pushOutcomes()
    return `\n「${f.label}」现在显示「${[f.value].flat().join('/')}」，已经填好了。`
  }

  async tool(call: ToolCall): Promise<string> {
    const a = call.args ?? {}
    const fieldOp = ['fill', 'select', 'cascade', 'date', 'check'].includes(call.name)
    if (fieldOp) this.openedField = undefined
    const key = `${call.name}|${a.ref}|${JSON.stringify([a.value, a.values, a.path, a.checked, a.end])}`
    if (fieldOp) {
      const tries = this.r.outcomes.get(a.ref)?.attempts ?? 0
      if (tries >= 5) return `「${this.r.field(a.ref)?.label ?? a.ref}」已经尝试了 ${tries} 次，不要再试，调用 give_up 说明原因。`
      // 同一个动作、同样的值已经失败两次：结果不会变，别再试
      const n = this.failedTries.get(key) ?? 0
      if (n >= 2) {
        this.r.log(`${call.name} ${a.ref} 同样的值已经失败 ${n} 次，不再执行`)
        return `同样的 ${call.name} ${a.ref}（同样的值）已经失败了 ${n} 次，结果不会变。不要再试同样的值：换别的做法，或者调用 give_up。`
      }
    }
    const fmt = (r: ActionResult) => {
      if (fieldOp && !r.ok) this.failedTries.set(key, (this.failedTries.get(key) ?? 0) + 1)
      return JSON.stringify({ ok: r.ok, readback: r.readback, error: r.error, observed: r.observed, pageChanged: r.pageChanged ? '页面结构变化了，必要时调用 snapshot' : undefined })
    }
    switch (call.name) {
      case 'fill':
        return fmt(await this.r.exec({ ref: a.ref, op: 'fill', value: String(a.value ?? '') }))
      case 'select':
        return fmt(await this.r.exec({ ref: a.ref, op: 'select', value: a.values?.length ? a.values : a.value }))
      case 'cascade':
        return fmt(await this.r.exec({ ref: a.ref, op: 'cascade', value: a.path }))
      case 'date':
        return fmt(await this.r.exec({ ref: a.ref, op: 'date', value: a.end ? [a.value, a.end] : a.value }))
      case 'check':
        return fmt(await this.r.exec({ ref: a.ref, op: 'check', value: !!a.checked }))
      case 'upload': {
        const f = this.r.field(a.ref)
        if (f && this.r.uploaded.has(f.label)) return '这个文件本次已经上传过了，不要重复上传（重复上传会让页面重新解析、清空已填内容）。'
        return fmt(await this.r.exec({ ref: a.ref, op: 'upload', fileId: a.fileId }))
      }
      case 'click':
      case 'type_keys':
      case 'open':
      case 'observe': {
        const btn = this.r.snap.buttons.find((b) => b.ref === a.ref)
        if (call.name === 'click' && btn && SUBMIT_RE.test(btn.text)) return '不允许点击最终提交按钮，提交由候选人自己完成。'
        const r = await this.r.act({ op: call.name as Action['op'], ref: a.ref, value: call.name === 'type_keys' ? a.keys : a.mode, trusted: a.trusted })
        if (call.name === 'observe' || call.name === 'open') {
          const k = `${call.name}|${a.ref}|${a.mode ?? ''}`
          const sig = JSON.stringify([r.ok, r.readback, r.error, r.observed])
          const prev = this.seen.get(k)
          const n = prev?.sig === sig ? prev.n + 1 : 1
          this.seen.set(k, { sig, n })
          if (n >= 2) {
            this.r.log(`${call.name} ${a.ref}（结果和上次相同，第 ${n} 次）`)
            return `和上一次 ${call.name} ${a.ref} 的结果完全相同（第 ${n} 次），控件没有变化。不要再查看它：用上次的现场直接执行 select/date/cascade/click，或者 give_up。`
          }
        }
        this.r.log(`${call.name} ${a.ref}${r.ok ? '' : ' ✗ ' + (r.error ?? '')}`)
        if (call.name === 'open' && r.ok && this.r.field(a.ref)) this.openedField = a.ref
        else if (call.name === 'click' && this.openedField && !this.r.field(a.ref)) return fmt(r) + (await this.pickedInPanel(this.openedField))
        return fmt(r)
      }
      case 'snapshot':
        await this.r.waitStable()
        await this.r.snapshot()
        return a.full ? snapshotText(this.r.snap, this.r.c.mem) : this.focusSnapshot()
      case 'ask_user': {
        const f = a.ref ? this.r.field(a.ref) : undefined
        if (a.ref && (this.r.queuedAsk.has(a.ref) || this.r.askedRefs.has(a.ref)))
          return this.r.askedRefs.get(a.ref) === 'skipped' ? '候选人已经跳过了这个字段，不要再问，留空即可。' : '这个字段会单独问候选人（或已经问过），不要再问，也不要处理它。'
        if (this.r.askedQuestions.has(a.question)) return '这个问题本次已经问过了，不要再问。'
        this.r.askedQuestions.add(a.question)
        const ans = await this.r.ask(a.question, a.options, f?.label)
        if (a.ref) this.r.markAsked([a.ref], ans)
        if (ans) await this.r.remember(a.question, ans)
        return ans ? `候选人回答：${ans}` : '候选人跳过了这个问题，不要再问，留空即可。'
      }
      case 'give_up': {
        const o = this.r.outcomes.get(a.ref)
        const f = this.r.field(a.ref)
        this.r.outcomes.set(a.ref, { ref: a.ref, label: f?.label ?? o?.label ?? a.ref, section: f?.section, planned: o?.planned, actual: f?.value, status: 'failed', attempts: o?.attempts ?? 0, note: a.reason })
        this.r.log(`放弃 ${f?.label ?? a.ref}：${a.reason}`, 'warn')
        this.r.pushOutcomes()
        return 'ok'
      }
      case 'finish':
        // 模型有时把 notes 传成一整句字符串，直接 for...of 会拆成单字
        for (const raw of Array.isArray(a.notes) ? a.notes : [a.notes]) {
          const n = typeof raw === 'string' ? raw.trim() : ''
          if (!n || this.r.c.mem.notes.includes(n)) continue
          this.r.c.mem.notes.push(n)
          this.r.newNotes.push(n)
        }
        if (a.summary) this.r.log(a.summary, 'ai')
        return 'ok'
    }
    return '未知工具'
  }

}
