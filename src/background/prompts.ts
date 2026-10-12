import type { ToolDef } from './llm'
import pick from '../prompts/pick.md'
import planner from '../prompts/planner.md'
import repair from '../prompts/repair.md'
import resume from '../prompts/resume.md'

// 系统提示词在 src/prompts/*.md，构建时打包进扩展；planner / repair 里的 {{TODAY}} 在使用处换成当天日期。
export const PICK_SYSTEM = pick

export const PLANNER_SYSTEM = planner

export const REPAIR_SYSTEM = repair

const s = (description: string) => ({ type: 'string', description })
const obj = (props: Record<string, unknown>, required: string[]) => ({ type: 'object', properties: props, required })

export const TOOLS: ToolDef[] = [
  { name: 'fill', description: '在文本框/文本域中输入文本（会先清空）', parameters: obj({ ref: s('控件 ref'), value: s('文本') }, ['ref', 'value']) },
  {
    name: 'select',
    description: '选择选项：原生下拉、单选组、多选组、自定义下拉都用它。多选用 values。',
    parameters: obj({ ref: s('控件 ref'), value: s('选项文字（单选）'), values: { type: 'array', items: { type: 'string' }, description: '多个选项文字（多选）' } }, ['ref']),
  },
  { name: 'cascade', description: '级联选择（省市区等），逐级选择', parameters: obj({ ref: s('控件 ref'), path: { type: 'array', items: { type: 'string' } } }, ['ref', 'path']) },
  { name: 'date', description: '设置日期；区间控件提供 end', parameters: obj({ ref: s('控件 ref'), value: s('日期，如 2024-09 或 2024-09-01'), end: s('区间结束日期（可选）') }, ['ref', 'value']) },
  { name: 'check', description: '勾选/取消单个勾选框或开关', parameters: obj({ ref: s('控件 ref'), checked: { type: 'boolean' } }, ['ref', 'checked']) },
  { name: 'upload', description: '上传文件', parameters: obj({ ref: s('上传控件 ref'), fileId: s('文件 id') }, ['ref', 'fileId']) },
  { name: 'click', description: '点击任意元素（按钮、面板中的节点 n12 等）', parameters: obj({ ref: s('元素 ref'), trusted: { type: 'boolean', description: '使用真实鼠标事件' } }, ['ref']) },
  { name: 'type_keys', description: '在控件中按键或输入文字，如 ["浙江", "Enter"]', parameters: obj({ ref: s('控件 ref'), keys: { type: 'array', items: { type: 'string' } } }, ['ref', 'keys']) },
  { name: 'open', description: '打开下拉/日历等弹出面板，返回面板结构（节点带 ref，可直接 click）', parameters: obj({ ref: s('控件 ref') }, ['ref']) },
  { name: 'observe', description: '查看控件结构：subtree=控件自身，around=控件所在行，popup=当前打开的面板', parameters: obj({ ref: s('控件 ref'), mode: { type: 'string', enum: ['subtree', 'around', 'popup'] } }, ['ref']) },
  { name: 'snapshot', description: '重新获取表单快照（默认只含待处理字段所在分区和仍为空的必填字段；full=true 返回整页）', parameters: obj({ full: { type: 'boolean', description: '返回整页' } }, []) },
  { name: 'ask_user', description: '向候选人提问（资料里没有答案时）', parameters: obj({ question: s('问题'), options: { type: 'array', items: { type: 'string' } }, ref: s('相关控件 ref') }, ['question']) },
  { name: 'give_up', description: '放弃某个控件', parameters: obj({ ref: s('控件 ref'), reason: s('原因') }, ['ref', 'reason']) },
  { name: 'finish', description: '修复完成', parameters: obj({ summary: s('一句话总结'), notes: { type: 'array', items: { type: 'string' }, description: '对本站点控件操作有用的经验（保存在本机，下次填写同一站点时使用；不要写任何人的姓名、电话、学校等资料值）' } }, ['summary']) },
]

export const RESUME_SYSTEM = resume

/** 本地日期 YYYY-MM-DD */
export const today = () => {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}
