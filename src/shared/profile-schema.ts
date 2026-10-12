// 资料的展示结构：分区、字段中文名。只用于界面显示和编辑，填写时模型读的是完整资料，不依赖这里。
import type { Profile } from './types'

export const LABELS: Record<string, string> = {
  name: '姓名', nameEn: '英文名', gender: '性别', birthDate: '出生日期', phone: '手机', email: '邮箱', wechat: '微信', idType: '证件类型', idNumber: '证件号码',
  nationality: '国籍', ethnicity: '民族', politicalStatus: '政治面貌', maritalStatus: '婚姻状况', hometown: '籍贯', hukou: '户口所在地', currentCity: '现居城市', address: '通讯地址',
  school: '学校', degree: '学历', studyMode: '学习形式', major: '专业', college: '学院', start: '开始时间', end: '结束时间', gpa: 'GPA', rank: '排名', courses: '主修课程', thesis: '毕业论文',
  company: '公司', title: '职位', department: '部门', city: '城市', description: '描述', role: '角色/职务', tech: '技术栈', level: '级别/水平', date: '时间', score: '成绩', org: '组织',
  cities: '期望城市', positions: '期望职位', salary: '期望薪资', availableFrom: '最早到岗', acceptAdjust: '服从调剂', internshipDuration: '实习时长',
  selfIntro: '自我评价', strengths: '优势', weaknesses: '不足', careerPlan: '职业规划', github: 'GitHub', blog: '博客', linkedin: 'LinkedIn', portfolio: '作品集',
}

export const SECTIONS: { key: keyof Profile; title: string; kind: 'obj' | 'list' | 'tags'; fields: string[] }[] = [
  { key: 'basics', title: '基本信息', kind: 'obj', fields: ['name', 'nameEn', 'gender', 'birthDate', 'phone', 'email', 'wechat', 'idType', 'idNumber', 'nationality', 'ethnicity', 'politicalStatus', 'maritalStatus', 'hometown', 'hukou', 'currentCity', 'address'] },
  { key: 'education', title: '教育经历', kind: 'list', fields: ['school', 'degree', 'studyMode', 'major', 'college', 'start', 'end', 'gpa', 'rank', 'courses'] },
  { key: 'experience', title: '实习/工作经历', kind: 'list', fields: ['company', 'title', 'department', 'city', 'start', 'end', 'description'] },
  { key: 'projects', title: '项目经历', kind: 'list', fields: ['name', 'role', 'start', 'end', 'tech', 'description'] },
  { key: 'awards', title: '获奖', kind: 'list', fields: ['name', 'level', 'date', 'description'] },
  { key: 'campus', title: '校园经历', kind: 'list', fields: ['org', 'role', 'start', 'end', 'description'] },
  { key: 'languages', title: '语言能力', kind: 'list', fields: ['name', 'level', 'score'] },
  { key: 'certificates', title: '证书', kind: 'list', fields: ['name', 'date', 'score'] },
  { key: 'skills', title: '技能', kind: 'tags', fields: [] },
  { key: 'jobPreference', title: '求职意向', kind: 'obj', fields: ['cities', 'positions', 'salary', 'availableFrom', 'acceptAdjust', 'internshipDuration'] },
  { key: 'links', title: '链接', kind: 'obj', fields: ['github', 'blog', 'linkedin', 'portfolio'] },
  { key: 'freeText', title: '常用长文本', kind: 'obj', fields: ['selfIntro', 'strengths', 'weaknesses', 'careerPlan'] },
  { key: 'extra', title: '其他信息（任意补充）', kind: 'obj', fields: [] },
]

export const FILE_KIND: Record<string, string> = { resume: '简历', photo: '证件照', transcript: '成绩单', certificate: '证书', other: '其他' }

/** 长文本字段：编辑用多行输入框，展示时保留换行 */
export const LONG_FIELDS = new Set(['description', 'selfIntro', 'strengths', 'weaknesses', 'careerPlan', 'courses', 'address'])

/** 值转成显示/复制用的文字：数组用顿号连接 */
export const valueText = (v: unknown): string =>
  Array.isArray(v) ? v.map(valueText).filter(Boolean).join('、')
  : v == null ? ''
  : typeof v === 'boolean' ? (v ? '是' : '否')
  : typeof v === 'object' ? JSON.stringify(v)
  : String(v)
