// 全局共享类型。资料结构刻意宽松：所有对象允许任意扩展字段，模型直接读全部内容。

export type Dict = Record<string, unknown>

export interface Profile {
  basics: Dict
  education: Dict[]
  experience: Dict[]
  projects: Dict[]
  awards: Dict[]
  campus: Dict[]
  skills: string[]
  languages: Dict[]
  certificates: Dict[]
  jobPreference: Dict
  links: Dict
  freeText: Dict
  extra: Dict
  resumeText?: string
}

export interface QA { q: string; a: string; updatedAt: number; source: 'user' | 'learned' }

export interface StoredFile { id: string; name: string; kind: 'resume' | 'photo' | 'transcript' | 'certificate' | 'other'; mime: string; size: number }

export interface ModelConfig { provider: 'openai' | 'anthropic'; baseURL: string; apiKey: string; model: string; headers?: Record<string, string> }

export interface Settings {
  /** 规划、修复、简历解析用的模型（用户在设置页自己填接口地址和 API Key） */
  planner: ModelConfig
  /** 选项匹配等小任务用的模型；sameAsPlanner 时直接用 planner */
  fast: ModelConfig & { sameAsPlanner: boolean }
  autoNext: boolean
  trustedInput: 'auto' | 'off' | 'always'
  /** 修复轮数上限 */
  maxRepairRounds: number
}

// ---------- 感知 ----------

export type WidgetHint =
  | 'text' | 'textarea' | 'number' | 'email' | 'tel' | 'password'
  | 'native-select' | 'radio-group' | 'checkbox' | 'checkbox-group' | 'switch'
  | 'custom-select' | 'cascader' | 'date' | 'date-range' | 'file' | 'richtext' | 'unknown'

export interface FieldNode {
  ref: string
  hint: WidgetHint
  label: string
  context: string[]
  required: boolean
  value: string | string[] | boolean | null
  options?: string[]
  optionsCollapsed?: boolean
  placeholder?: string
  constraints?: { maxLength?: number; accept?: string; multiple?: boolean; readonly?: boolean }
  error?: string
  section?: string
  disabled?: boolean
  order: number
}

export interface ButtonNode { ref: string; text: string; section?: string; order: number }

export interface FrameSnapshot {
  frameId: number
  url: string
  title: string
  heading?: string
  fields: FieldNode[]
  buttons: ButtonNode[]
}

export interface FormSnapshot {
  url: string
  title: string
  heading?: string
  fields: FieldNode[]
  buttons: ButtonNode[]
  takenAt: number
}

// ---------- 执行 ----------

export type ActionOp = 'fill' | 'select' | 'cascade' | 'date' | 'check' | 'upload' | 'click' | 'type_keys' | 'observe' | 'open' | 'scroll' | 'clear'

export interface Action {
  op: ActionOp
  ref: string
  value?: string | string[] | boolean
  /** upload 用：文件 base64 */
  file?: { name: string; mime: string; base64: string }
  trusted?: boolean
}

export interface ActionResult {
  ok: boolean
  ref: string
  readback?: string | string[] | boolean | null
  error?: string
  observed?: string
  pageChanged?: { added: number; removed: number }
  path?: string
  /** 动作内部分步耗时（诊断用） */
  prof?: { total: number; steps: [string, number][]; hot: Record<string, { ms: number; n: number }>; slept: number }
}

// ---------- Agent ----------

export interface PlanAction {
  ref: string
  op: 'fill' | 'select' | 'cascade' | 'date' | 'check' | 'upload' | 'click'
  value?: string | string[] | boolean
  fileId?: string
  source?: string
  generated?: boolean
  /** 资料里没有直接写、由 AI 推导出来的值：需要候选人确认一次 */
  inferred?: boolean
  reason?: string
}

/** 添加按钮的定位键：页面重新渲染后按"分区 + 文字 + 同名序号"找回同一个按钮，绝不退回到页面上第一个同名按钮 */
export interface BlockKey { ref: string; text: string; section?: string; nth: number }

export interface FillPlan {
  addBlocks: { ref: string; times: number; why?: string; key?: BlockKey }[]
  actions: PlanAction[]
  skip: { ref: string; reason: string }[]
  questions: { refs: string[]; question: string; options?: string[] }[]
  nextRef?: string
  submitRef?: string
}

export type OutcomeStatus = 'filled' | 'generated' | 'failed' | 'skipped' | 'asked' | 'already-correct' | 'pending'

export interface FieldOutcome {
  ref: string
  label: string
  section?: string
  planned?: unknown
  actual?: unknown
  status: OutcomeStatus
  source?: string
  op?: string
  attempts: number
  note?: string
  /** 下拉里实际点中的那一项（没有完全一致的选项、选了最接近的时，和计划值不同） */
  picked?: string
}

export interface ConfirmItem { key: string; label: string; value: string; reason?: string }
export interface ConfirmDecision { key: string; use: boolean; value: string }

export type RunEvent =
  | { kind: 'status'; text: string; phase: string }
  | { kind: 'log'; text: string; level?: 'info' | 'warn' | 'error' | 'ai' }
  | { kind: 'outcomes'; outcomes: FieldOutcome[] }
  | { kind: 'question'; id: string; question: string; options?: string[]; label?: string }
  | { kind: 'confirm'; id: string; items: ConfirmItem[] }
  | { kind: 'usage'; calls: number; inTok: number; outTok: number }
  | { kind: 'done'; summary: string }

/** 站点经验：按站点存在本机，只记表单结构上的经验，不含任何人的资料值 */
export interface SiteMemory {
  origin: string
  updatedAt: number
  runs: number
  fieldMap: { label: string; section?: string; source?: string; op: string }[]
  optionCache: Record<string, string[]>
  notes: string[]
}

export const emptySite = (origin: string): SiteMemory => ({ origin, updatedAt: 0, runs: 0, fieldMap: [], optionCache: {}, notes: [] })

export const emptyProfile = (): Profile => ({
  basics: {}, education: [], experience: [], projects: [], awards: [], campus: [], skills: [],
  languages: [], certificates: [], jobPreference: {}, links: {}, freeText: {}, extra: {},
})

/** 资料档案：一份资料 + 问答库 + 附件 */
export interface Archive { id: string; name: string; createdAt: number; updatedAt: number }

/** 投递记录：只存在本机。同一网址一条，再次填写时更新 */
export interface ApplyRecord {
  id: string
  url: string
  host: string
  title: string
  archiveId: string
  archiveName: string
  note?: string
  createdAt: number
  updatedAt: number
  fills: number
  counts: Partial<Record<OutcomeStatus, number>>
  /** 没填上的字段名，方便回去手动补 */
  failed: string[]
}
