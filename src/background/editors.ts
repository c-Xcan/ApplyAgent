// 一次编辑一条的编辑框（"添加/保存 + 取消"）：填好当前这一条 → 保存 → 资料里还有就新增下一条接着填。
// 从 agent.ts 拆出来；页面操作、规划、提问都通过 EditorHost 调回 Run。
import type { Action, ActionResult, BlockKey, FieldNode, FieldOutcome, FillPlan, FormSnapshot, PlanAction } from '../shared/types'

export const SUBMIT_RE = /(提交|submit|投递|apply\s*now|确认申请|send application)/i
/** 编辑框里"保存这一条"的按钮（同一分区里还有"取消"时才算） */
const SAVE_RE = /^(添\s*加|保\s*存|确\s*定|完\s*成|确\s*认|save|ok|done)$/i
const CANCEL_RE = /^(取\s*消|cancel)$/i
/** 打开一条新记录的按钮（编辑框收起后，分区里的"添加/新增"） */
const NEW_ENTRY_RE = /(添\s*加|新\s*增|增\s*加|\+|plus|add)/i
export const isEmpty = (v: unknown) => v == null || v === '' || v === false || (Array.isArray(v) && v.every((x) => !x)) || /^(请选择|select)/i.test(String(v))

type Questions = FillPlan['questions']

/** 编辑框流程需要 Run 提供的能力 */
export interface EditorHost {
  snap: FormSnapshot
  outcomes: Map<string, FieldOutcome>
  askedRefs: Map<string, 'answered' | 'skipped'>
  askedQuestions: Set<string>
  repairHints: string[]
  readonly stopped: boolean
  log(text: string, level?: 'info' | 'warn' | 'error' | 'ai'): void
  snapshot(): Promise<FormSnapshot>
  waitStable(): Promise<unknown>
  plan(note?: string): Promise<FillPlan>
  exec(p: { ref: string; op: string; value?: unknown; source?: string }): Promise<ActionResult>
  execAll(actions: PlanAction[]): Promise<void>
  act(a: Action): Promise<ActionResult>
  ask(question: string, options?: string[], label?: string): Promise<string>
  markAsked(refs: string[], ans: string): void
  remember(q: string, a: string): Promise<void>
  field(ref: string): FieldNode | undefined
  confirmNow(list: PlanAction[]): Promise<void>
  tryAdd(k: BlockKey, why?: string, retry?: boolean): Promise<'ok' | 'blocked' | 'bad'>
  btnKey(ref: string): BlockKey
  /** 执行时判为失败、但页面上现在的值已经对了的（组件提交值慢）：改判为成功 */
  recheckFailed(section?: string): void
}

export class Editors {
  /** 分区 → 编辑框流程里还要再新增的条数 */
  entryPlans = new Map<string, number>()
  /** 分区 → 本次已经保存的条数 */
  savedEntries = new Map<string, number>()
  /** 有没填对的字段、推迟到修复之后再保存的分区（以及保存没成功、修复后再试一次的） */
  deferredSave = new Set<string>()
  /** 已经为它们单独规划过的新冒出来的字段（不重复规划） */
  freshTried = new Set<string>()

  constructor(private h: EditorHost) {}

  /** 分区里同时有"保存这一条"和"取消"按钮 = 正在编辑一条记录 */
  editorOf(section?: string) {
    const bs = this.h.snap.buttons.filter((b) => (b.section ?? '') === (section ?? ''))
    const save = bs.find((b) => SAVE_RE.test(b.text.trim()))
    const cancel = bs.find((b) => CANCEL_RE.test(b.text.trim()))
    return save && cancel && !SUBMIT_RE.test(save.text) ? { save, cancel } : null
  }
  sections() {
    return [...new Set(this.h.snap.fields.map((f) => f.section ?? ''))].filter((s) => this.editorOf(s))
  }
  /** 给规划模型的说明：这些分区是编辑框，按第几条填 */
  note() {
    return this.sections()
      .map((sec) => {
        const ed = this.editorOf(sec)!
        const done = this.savedEntries.get(sec) ?? 0
        return `「${sec}」是一次只编辑一条记录的编辑框（${ed.save.ref}「${ed.save.text}」= 保存当前这一条，${ed.cancel.ref}「${ed.cancel.text}」= 取消）。只按资料里这一类的第 ${done + 1} 条填写当前编辑框里的字段（先填上级字段，例如先选学历再选学位）；如果资料里这一类还有更多条，在 addBlocks 里写 ${ed.save.ref}，times = 还差的条数（总条数 − ${done + 1}），执行器会保存这一条后再新增下一条。`
      })
      .join('\n')
  }
  /** 规划把编辑框的"保存"按钮写进了 addBlocks：记下还要几条（返回 true = 这是编辑框的保存按钮，不当加块按钮） */
  takeAddBlock(b: { ref: string; times: number; key?: BlockKey }) {
    const ed = this.editorOf(b.key?.section)
    if (!ed || ed.save.ref !== b.ref) return false
    const sec = b.key?.section ?? ''
    if (!this.entryPlans.has(sec)) {
      this.entryPlans.set(sec, Math.min(b.times, 15))
      this.h.log(`「${sec}」是一次编辑一条的编辑框：填好一条就点「${ed.save.text}」保存，再新增下一条（还要 ${b.times} 条）`)
    }
    return true
  }
  isSaveButton(ref?: string) {
    const b = this.h.snap.buttons.find((x) => x.ref === ref)
    return !!b && this.editorOf(b.section)?.save.ref === b.ref
  }

  /** 逐个编辑框：保存当前这一条；资料里还有就新增一条、按下一条填写，再保存。
   *  afterRepair：修复之后再来保存（之前因为有没填对的字段、或保存没成功而推迟的）。
   *  一个分区处理不了（推迟/保存失败/你跳过了必填项）只跳过这个分区，接着处理别的分区 */
  async run(inferred: PlanAction[], questions: Questions, afterRepair = false) {
    const h = this.h
    const handled = new Set<string>()
    for (let guard = 0; guard < 30 && !h.stopped; guard++) {
      await h.snapshot()
      const sec = this.sections().find((s) => !handled.has(s) && (!afterRepair || this.deferredSave.has(s)) && h.snap.fields.some((f) => (f.section ?? '') === s && h.outcomes.has(f.ref)))
      if (sec === undefined) return
      const ed = this.editorOf(sec)!
      const inSec = new Set(h.snap.fields.filter((f) => (f.section ?? '') === sec).map((f) => f.ref))
      // 保存前先把这一条里等确认的推导、要问的问题处理掉（保存后编辑框收起，就填不进去了）
      const mine = inferred.filter((a) => inSec.has(a.ref))
      inferred.splice(0, inferred.length, ...inferred.filter((a) => !inSec.has(a.ref)))
      await h.confirmNow(mine)
      for (const q of questions.filter((q) => q.refs.some((r) => inSec.has(r)) && !q.refs.every((r) => h.askedRefs.has(r)))) {
        h.askedQuestions.add(q.question)
        const ans = await h.ask(q.question, q.options, q.refs.map((r) => h.field(r)?.label).filter(Boolean).join('、'))
        h.markAsked(q.refs, ans)
        if (!ans) continue
        await h.remember(q.question, ans)
        for (const r of q.refs) {
          const f = h.field(r)
          if (!f) continue
          const op = f.hint === 'date' || f.hint === 'date-range' ? 'date' : ['custom-select', 'native-select', 'radio-group', 'checkbox-group', 'cascader'].includes(f.hint) ? 'select' : 'fill'
          await h.exec({ ref: r, op, value: ans, source: '你的回答' })
        }
      }
      // 选了某项之后才冒出来的字段（例如选了"身份证"才有"证件号码"）：保存前补上，资料里没有的会问你
      await h.snapshot()
      const fresh = h.snap.fields.filter((f) => (f.section ?? '') === sec && f.required && isEmpty(f.value) && !f.disabled && !h.outcomes.has(f.ref) && !h.askedRefs.has(f.ref) && !this.freshTried.has(f.ref))
      if (fresh.length && !afterRepair) {
        fresh.forEach((f) => this.freshTried.add(f.ref))
        h.log(`「${sec}」里新出现了 ${fresh.length} 个必填字段（${fresh.map((f) => f.label).join('、')}），保存前先填上`)
        const p = await h.plan(`「${sec}」里刚新出现了这些必填字段：${fresh.map((f) => f.ref + '「' + f.label + '」').join('、')}。只为这些字段生成动作；资料里没有、也推导不出的放进 questions；其他字段不要动，addBlocks 留空。`)
        const want = new Set(fresh.map((f) => f.ref))
        const acts = p.actions.filter((a) => want.has(a.ref) && a.op !== 'upload')
        inferred.push(...acts.filter((a) => a.inferred && !a.generated))
        await h.execAll(acts.filter((a) => !(a.inferred && !a.generated)))
        questions.push(...p.questions.filter((q) => q.refs.some((r) => want.has(r))))
        continue // 回到循环开头：先处理这些字段的确认和提问，再保存
      }
      // 执行时回读是空的、现在已经显示正确值的（组件提交值慢）不算没填对
      h.recheckFailed(sec)
      // 还有没填对的字段：先不保存，等修复完再保存（保存时校验过不去只会白点一次）
      const bad = h.snap.fields.filter((f) => (f.section ?? '') === sec && (h.outcomes.get(f.ref)?.status === 'failed' || (f.error && h.outcomes.has(f.ref))))
      if (bad.length && !afterRepair) {
        h.log(`「${sec}」还有 ${bad.length} 个字段没填对（${bad.map((f) => f.label).join('、')}），修复后再保存`)
        this.deferredSave.add(sec)
        handled.add(sec)
        continue
      }
      // 你跳过的必填项：保存一定会被页面校验拦下，不去点保存、也不交给修复
      const skipped = h.snap.fields.filter((f) => (f.section ?? '') === sec && f.required && isEmpty(f.value) && !f.disabled && h.askedRefs.get(f.ref) === 'skipped')
      if (skipped.length) {
        h.log(`「${sec}」里必填的「${skipped.map((f) => f.label).join('、')}」你跳过了，这一条保存会被页面校验拦下，先不保存：在页面上补填后自己点「${ed.save.text}」`, 'warn')
        this.deferredSave.delete(sec)
        handled.add(sec)
        continue
      }
      // 保存这一条
      this.deferredSave.delete(sec)
      h.log(`保存「${sec}」这一条：点击「${ed.save.text}」`)
      await h.act({ op: 'click', ref: ed.save.ref })
      await h.waitStable()
      await h.snapshot()
      const secFields = h.snap.fields.filter((f) => (f.section ?? '') === sec)
      const errs = secFields.filter((f) => f.error).map((f) => `${f.label}：${f.error}`)
      const emptyReq = secFields.filter((f) => f.required && isEmpty(f.value) && !f.disabled)
      const still = !!this.editorOf(sec)
      const reopened = still && !errs.length && secFields.length > 0 && secFields.every((f) => isEmpty(f.value))
      // 没保存成功 = 编辑框还在，并且页面报错或必填项还空着。
      // 编辑框没收起、但没有报错也没有空着的必填项：有的站点保存后表单照样开着，按已保存处理（不触发修复）
      if (still && !reopened && (errs.length || emptyReq.length)) {
        const why = errs.length ? errs.join('；') : `必填的「${emptyReq.map((f) => f.label).join('、')}」是空的`
        h.log(`「${sec}」这一条没有保存成功（${why}）`, 'warn')
        h.repairHints.push(`「${sec}」当前这一条还没保存成功（${errs.length ? '页面报错：' : ''}${why}）：把这些字段改好后，点击这个分区的「${this.editorOf(sec)?.save.text ?? ed.save.text}」按钮保存。`)
        if (!afterRepair) this.deferredSave.add(sec)
        handled.add(sec)
        continue
      }
      if (still && !reopened) h.log(`已点击「${ed.save.text}」，页面没有报错，编辑框没有收起（这个站点保存后表单保持打开），按已保存处理`)
      const n = (this.savedEntries.get(sec) ?? 0) + 1
      this.savedEntries.set(sec, n)
      h.log(`已保存「${sec}」第 ${n} 条`)
      const left = this.entryPlans.get(sec) ?? 0
      if (left <= 0) {
        // 站点自动开了一条空白记录、或保存后表单保持打开：资料已经填完了，留着不动
        if (still) handled.add(sec)
        continue
      }
      if (reopened) {
        this.entryPlans.set(sec, left - 1)
        await this.fillNext(sec, n, inferred, questions)
        continue
      }
      // 打开下一条
      const btn = h.snap.buttons
        .filter((b) => (b.section ?? '') === sec && NEW_ENTRY_RE.test(b.text) && !SUBMIT_RE.test(b.text) && b.ref !== this.editorOf(sec)?.save.ref)
        .sort((p, q) => p.order - q.order)[0]
      if (!btn) {
        h.log(`「${sec}」保存后找不到新增下一条的按钮，资料里还有 ${left} 条没有填`, 'warn')
        this.entryPlans.set(sec, 0)
        if (still) handled.add(sec)
        continue
      }
      const r = await h.tryAdd(h.btnKey(btn.ref), `资料里还有 ${left} 条`)
      if (r !== 'ok') {
        h.log(`「${sec}」没能打开新的一条，资料里还有 ${left} 条没有填`, 'warn')
        this.entryPlans.set(sec, 0)
        if (still) handled.add(sec)
        continue
      }
      this.entryPlans.set(sec, left - 1)
      await this.fillNext(sec, n, inferred, questions)
    }
  }

  async fillNext(sec: string, n: number, inferred: PlanAction[], questions: Questions) {
    const h = this.h
    const p = await h.plan(`「${sec}」刚打开了一条新的空白记录。只为这个编辑框里的字段生成动作，按资料里这一类的第 ${n + 1} 条填写；其他字段不要动，addBlocks 留空。`)
    const order = new Map(h.snap.fields.map((f) => [f.ref, f.order]))
    const acts = p.actions.filter((x) => x.op !== 'upload').sort((a, b) => (order.get(a.ref) ?? 0) - (order.get(b.ref) ?? 0))
    inferred.push(...acts.filter((a) => a.inferred && !a.generated))
    await h.execAll(acts.filter((a) => !(a.inferred && !a.generated)))
    questions.push(...p.questions)
  }
}
