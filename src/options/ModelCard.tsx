import { useState } from 'react'
import type { ModelConfig, Settings } from '../shared/types'
import { Icon } from '../shared/icons'
import { Select } from '../shared/ui'

const PROVIDERS = [
  { value: 'openai', label: 'OpenAI 兼容接口', hint: 'DeepSeek、通义千问、Kimi、智谱、OpenAI 等' },
  { value: 'anthropic', label: 'Anthropic（Claude）' },
]

/** 一组模型接口：协议、接口地址、API Key、模型名，外加测试连接 */
function ModelFields({ value, onChange }: { value: ModelConfig; onChange: (v: ModelConfig) => void }) {
  const [show, setShow] = useState(false)
  const [test, setTest] = useState<{ busy?: boolean; ok?: boolean; text?: string }>({})
  const set = (patch: Partial<ModelConfig>) => { onChange({ ...value, ...patch }); setTest({}) }
  const run = async () => {
    setTest({ busy: true })
    try {
      const r = await chrome.runtime.sendMessage({ t: 'llm.test', config: value })
      setTest(r?.ok ? { ok: true, text: `连接成功，模型回复：${r.text || '（空）'}` } : { ok: false, text: r?.error ?? '失败' })
    } catch (e) {
      setTest({ ok: false, text: (e as Error).message })
    }
  }
  return (
    <>
      <div className="kv-row"><span>接口类型</span>
        <Select value={value.provider} options={PROVIDERS} onChange={(v) => set({ provider: v as ModelConfig['provider'] })} />
      </div>
      <div className="kv-row"><span>接口地址</span>
        <input value={value.baseURL} placeholder={value.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com'} onChange={(e) => set({ baseURL: e.target.value.trim() })} />
      </div>
      <div className="kv-row"><span>API Key</span>
        <div className="row">
          <input className="grow" type={show ? 'text' : 'password'} value={value.apiKey} autoComplete="off" spellCheck={false} placeholder="sk-..." onChange={(e) => set({ apiKey: e.target.value.trim() })} />
          <button className="btn small" onClick={() => setShow(!show)}>{show ? '隐藏' : '显示'}</button>
        </div>
      </div>
      <div className="kv-row"><span>模型名</span>
        <input value={value.model} placeholder={value.provider === 'anthropic' ? 'claude-sonnet-4-5' : 'deepseek-chat'} onChange={(e) => set({ model: e.target.value.trim() })} />
      </div>
      <div className="kv-row"><span />
        <div className="row">
          <button className="btn small" disabled={test.busy || !value.baseURL || !value.model} onClick={run}>
            <Icon name="loader-circle" size={13} className={test.busy ? 'spin' : ''} />{test.busy ? '测试中…' : '测试连接'}
          </button>
          {test.text && <span className={'small ' + (test.ok ? 'ok' : 'bad')}>{test.text}</span>}
        </div>
      </div>
    </>
  )
}

/** 模型设置：API Key 只保存在本机浏览器里，填写时扩展直接调用这个接口 */
export function ModelCard({ s, upd }: { s: Settings; upd: (v: Settings) => void }) {
  return (
    <div className="card">
      <div className="card-title">模型</div>
      <div className="muted small">填写表单和解析简历都直接调用你在这里填的模型接口，API Key 只保存在本机浏览器里。需要支持工具调用（function calling）的模型。</div>
      <ModelFields value={s.planner} onChange={(planner) => upd({ ...s, planner })} />
      <label className="row small">
        <input type="checkbox" checked={s.fast.sameAsPlanner} onChange={(e) => upd({ ...s, fast: { ...s.fast, sameAsPlanner: e.target.checked } })} />
        选项匹配等小任务也用这个模型
      </label>
      {!s.fast.sameAsPlanner && (
        <>
          <div className="muted small">小任务模型：用来在下拉选项里挑选最接近的一项，可以填更快、更便宜的模型。</div>
          <ModelFields value={s.fast} onChange={(fast) => upd({ ...s, fast: { ...fast, sameAsPlanner: false } })} />
        </>
      )}
    </div>
  )
}
