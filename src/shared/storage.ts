import { SAMPLE_ID, SAMPLE_NAME, SAMPLE_PROFILE, SAMPLE_QA } from './sample-profile'
import { emptyProfile, emptySite, type ApplyRecord, type Archive, type FieldOutcome, type ModelConfig, type Profile, type QA, type Settings, type SiteMemory, type StoredFile } from './types'

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

const get = async <T>(key: string, fallback: T): Promise<T> => {
  const r = await chrome.storage.local.get(key)
  return (r[key] as T) ?? fallback
}
const set = (key: string, value: unknown) => chrome.storage.local.set({ [key]: value })

let qaLock: Promise<void> = Promise.resolve()
let archLock: Promise<void> = Promise.resolve()
let appLock: Promise<void> = Promise.resolve()
let siteLock: Promise<void> = Promise.resolve()

export const defaultSettings = (): Settings => ({
  planner: { provider: 'openai', baseURL: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat' },
  fast: { provider: 'openai', baseURL: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat', sameAsPlanner: true },
  autoNext: true,
  trustedInput: 'auto',
  maxRepairRounds: 6,
})

/** 本机跑的模型服务（Ollama 等）可以不填 API Key */
export const isLocalModel = (baseURL: string) => /localhost|127\.0\.0\.1/.test(baseURL)

const modelOk = (m: ModelConfig) => !!m.baseURL.trim() && !!m.model.trim() && (!!m.apiKey.trim() || isLocalModel(m.baseURL))

/** 设置页里的模型接口是否已经填好 */
export const modelReady = (s: Settings) => modelOk(s.planner) && (s.fast.sameAsPlanner || modelOk(s.fast))

/** 一次填写使用的两档模型 */
export const modelConfigs = (s: Settings): { planner: ModelConfig; fast: ModelConfig } => ({ planner: s.planner, fast: s.fast.sameAsPlanner ? s.planner : s.fast })

const SITE_MAX_FIELDS = 200
const SITE_MAX_OPTION_KEYS = 300
const SITE_MAX_NOTES = 40

/** 把一次填写学到的经验合并进已有的：同一字段、同一下拉以新的为准，笔记去重追加 */
function mergeSite(cur: SiteMemory, inc: SiteMemory): SiteMemory {
  const fields = new Map(cur.fieldMap.map((f) => [f.label + '\u0000' + (f.section ?? ''), f]))
  for (const f of inc.fieldMap) {
    const k = f.label + '\u0000' + (f.section ?? '')
    fields.delete(k)
    fields.set(k, f)
  }
  const options = { ...cur.optionCache }
  for (const [label, values] of Object.entries(inc.optionCache)) {
    delete options[label]
    options[label] = values
  }
  const notes = [...cur.notes, ...inc.notes.filter((n) => !cur.notes.includes(n))]
  return {
    origin: cur.origin,
    updatedAt: Date.now(),
    runs: cur.runs + 1,
    fieldMap: [...fields.values()].slice(-SITE_MAX_FIELDS),
    optionCache: Object.fromEntries(Object.entries(options).slice(-SITE_MAX_OPTION_KEYS)),
    notes: notes.slice(-SITE_MAX_NOTES),
  }
}

export const store = {
  async settings(): Promise<Settings> {
    const s = await get<Partial<Settings>>('settings', {})
    const d = defaultSettings()
    return { ...d, ...s, planner: { ...d.planner, ...s.planner }, fast: { ...d.fast, ...s.fast } }
  },
  saveSettings: (s: Settings) => set('settings', s),

  // ---------- 资料档案：每个档案有自己的资料、问答库、附件 ----------
  /** 档案列表；第一次调用时把旧版的单份资料迁移成"默认档案" */
  archives(): Promise<{ list: Archive[]; active: string }> {
    // 串行化：页面上多处同时读取时，迁移只做一次
    const r = archLock.then(() => store._archives())
    archLock = r.then(() => {}, () => {})
    return r
  },
  async _archives(): Promise<{ list: Archive[]; active: string }> {
    let list = await get<Archive[]>('archives', [])
    let active = await get<string>('activeArchive', '')
    if (!list.length) {
      // 固定 id + 只在"有旧数据或目标为空"时写入：侧边栏和后台同时迁移也不会互相覆盖
      const id = 'default'
      const r = await chrome.storage.local.get(['profile', 'qa', 'files', 'profile:' + id, 'qa:' + id, 'files:' + id])
      const name = ((r.profile ?? r['profile:' + id]) as Profile | undefined)?.basics?.name
      list = [{ id, name: name ? `${name}的档案` : '默认档案', createdAt: Date.now(), updatedAt: Date.now() }]
      const data: Record<string, unknown> = { archives: list, activeArchive: id }
      for (const k of ['profile', 'qa', 'files'] as const) {
        if (r[k] !== undefined) data[k + ':' + id] = r[k]
        else if (r[k + ':' + id] === undefined) data[k + ':' + id] = k === 'profile' ? {} : []
      }
      await chrome.storage.local.set(data)
      await chrome.storage.local.remove(['profile', 'qa', 'files'])
      active = id
    }
    // 自带一份示例档案（只加一次；用户删掉后不会再出现）。不切换当前档案。
    if (!(await get<boolean>('sampleSeeded', false))) {
      const data: Record<string, unknown> = { sampleSeeded: true }
      if (!list.some((a) => a.id === SAMPLE_ID)) {
        list = [...list, { id: SAMPLE_ID, name: SAMPLE_NAME, createdAt: Date.now(), updatedAt: Date.now() }]
        Object.assign(data, { archives: list, ['profile:' + SAMPLE_ID]: SAMPLE_PROFILE, ['qa:' + SAMPLE_ID]: SAMPLE_QA, ['files:' + SAMPLE_ID]: [] })
      }
      await chrome.storage.local.set(data)
    }
    if (!list.some((a) => a.id === active)) {
      active = list[0].id
      await set('activeArchive', active)
    }
    return { list, active }
  },
  async activeId(): Promise<string> {
    return (await store.archives()).active
  },
  setActive: (id: string) => set('activeArchive', id),
  async createArchive(name: string, from?: string): Promise<string> {
    const { list } = await store.archives()
    const id = newId()
    const now = Date.now()
    const data: Record<string, unknown> = { ['profile:' + id]: {}, ['qa:' + id]: [], ['files:' + id]: [] }
    if (from) {
      const r = await chrome.storage.local.get(['profile:' + from, 'qa:' + from, 'files:' + from])
      data['profile:' + id] = r['profile:' + from] ?? {}
      data['qa:' + id] = r['qa:' + from] ?? []
      // 附件内容按 fileId 共享存储，复制档案时复制一份新的 id，删除互不影响
      const files = (r['files:' + from] as StoredFile[] | undefined) ?? []
      const copied: StoredFile[] = []
      for (const f of files) {
        const b = await store.fileData(f.id)
        const nid = newId()
        if (b) data['file:' + nid] = b
        copied.push({ ...f, id: nid })
      }
      data['files:' + id] = copied
    }
    await chrome.storage.local.set({ ...data, archives: [...list, { id, name, createdAt: now, updatedAt: now }], activeArchive: id })
    return id
  },
  async renameArchive(id: string, name: string) {
    const { list } = await store.archives()
    await set('archives', list.map((a) => (a.id === id ? { ...a, name, updatedAt: Date.now() } : a)))
  },
  async deleteArchive(id: string) {
    const { list, active } = await store.archives()
    if (list.length <= 1) return
    const files = await get<StoredFile[]>('files:' + id, [])
    await chrome.storage.local.remove(['profile:' + id, 'qa:' + id, 'files:' + id, ...files.map((f) => 'file:' + f.id)])
    const rest = list.filter((a) => a.id !== id)
    await chrome.storage.local.set({ archives: rest, activeArchive: active === id ? rest[0].id : active })
  },
  async touch(id: string) {
    const list = await get<Archive[]>('archives', [])
    await set('archives', list.map((a) => (a.id === id ? { ...a, updatedAt: Date.now() } : a)))
  },

  async profile(id?: string): Promise<Profile> {
    id ??= await store.activeId()
    return { ...emptyProfile(), ...(await get<Partial<Profile>>('profile:' + id, {})) }
  },
  async saveProfile(p: Profile, id?: string) {
    id ??= await store.activeId()
    await set('profile:' + id, p)
    await store.touch(id)
  },

  async qa(id?: string): Promise<QA[]> {
    id ??= await store.activeId()
    return get<QA[]>('qa:' + id, [])
  },
  async saveQa(q: QA[], id?: string) {
    id ??= await store.activeId()
    await set('qa:' + id, q)
  },
  /** 串行写入：多个回答同时保存时，避免读-改-写互相覆盖 */
  addQa(q: string, a: string, source: QA['source'] = 'user', id?: string) {
    qaLock = qaLock.then(async () => {
      const aid = id ?? (await store.activeId())
      const list = await store.qa(aid)
      const i = list.findIndex((x) => x.q.trim() === q.trim())
      const item = { q, a, source, updatedAt: Date.now() }
      if (i >= 0) list[i] = item
      else list.push(item)
      await store.saveQa(list, aid)
    })
    return qaLock
  },

  async files(id?: string): Promise<StoredFile[]> {
    id ??= await store.activeId()
    return get<StoredFile[]>('files:' + id, [])
  },
  async addFile(meta: StoredFile, base64: string, id?: string) {
    id ??= await store.activeId()
    const list = await store.files(id)
    await chrome.storage.local.set({ ['files:' + id]: [...list, meta], ['file:' + meta.id]: base64 })
  },
  async removeFile(fid: string, id?: string) {
    id ??= await store.activeId()
    const list = await store.files(id)
    await set('files:' + id, list.filter((f) => f.id !== fid))
    await chrome.storage.local.remove('file:' + fid)
  },
  fileData: (id: string) => get<string | null>('file:' + id, null),

  // ---------- 站点经验（只存本机，按 origin 一份） ----------
  async site(origin: string): Promise<SiteMemory> {
    return { ...emptySite(origin), ...(await get<Partial<SiteMemory>>('site:' + origin, {})), origin }
  },
  saveSite(m: SiteMemory) {
    siteLock = siteLock.then(async () => set('site:' + m.origin, mergeSite(await store.site(m.origin), m)), () => {})
    return siteLock
  },

  // ---------- 投递记录（只存本机） ----------
  applications: () => get<ApplyRecord[]>('applications', []),
  /** 一次填写结束后记一条；同一网址（忽略 #）合并，保留用户写的备注 */
  recordApplication(r: { url: string; title: string; archiveId: string; outcomes: FieldOutcome[] }) {
    appLock = appLock.then(async () => {
      const url = r.url.split('#')[0]
      const list = await store.applications()
      const archiveName = (await get<Archive[]>('archives', [])).find((a) => a.id === r.archiveId)?.name ?? ''
      const counts: ApplyRecord['counts'] = {}
      for (const o of r.outcomes) counts[o.status] = (counts[o.status] ?? 0) + 1
      const failed = r.outcomes.filter((o) => o.status === 'failed').map((o) => o.label || o.ref)
      const old = list.find((x) => x.url === url)
      const now = Date.now()
      const rec: ApplyRecord = old
        ? { ...old, title: r.title || old.title, archiveId: r.archiveId, archiveName, updatedAt: now, fills: old.fills + 1, counts, failed }
        : { id: newId(), url, host: new URL(url).hostname, title: r.title, archiveId: r.archiveId, archiveName, createdAt: now, updatedAt: now, fills: 1, counts, failed }
      await set('applications', [rec, ...list.filter((x) => x !== old)].slice(0, 1000))
    }, () => {})
    return appLock
  },
  async updateNote(id: string, note: string) {
    const list = await store.applications()
    await set('applications', list.map((x) => (x.id === id ? { ...x, note } : x)))
  },
  async removeApplications(ids: string[]) {
    const list = await store.applications()
    await set('applications', list.filter((x) => !ids.includes(x.id)))
  },
}
