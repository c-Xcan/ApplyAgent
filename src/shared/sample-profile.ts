// 插件自带的示例档案：第一次安装（或升级到带示例的版本）时加一份，删掉后不再自动出现。
// 人物是虚构的，联系方式用的是常见的示例号码 / example.com，不要拿去正式投递。
import type { Profile, QA } from './types'

export const SAMPLE_ID = 'sample'
export const SAMPLE_NAME = '示例档案'

export const SAMPLE_PROFILE: Profile = {
  basics: {
    name: '林小满',
    nameEn: 'Xiaoman Lin',
    gender: '女',
    birthDate: '2003-04-16',
    phone: '13800138000',
    email: 'xiaoman.lin@example.com',
    wechat: 'lin_xiaoman_demo',
    nationality: '中国',
    ethnicity: '汉族',
    politicalStatus: '共青团员',
    maritalStatus: '未婚',
    hometown: '浙江省宁波市',
    hukou: '浙江省宁波市',
    currentCity: '浙江省杭州市',
    address: '浙江省杭州市西湖区示例路 1 号',
  },
  education: [
    { school: '浙江大学', degree: '硕士', studyMode: '全日制', major: '计算机科学与技术', college: '计算机科学与技术学院', start: '2024-09', end: '2027-06', rank: '前 15%', courses: '分布式系统、高级算法、机器学习' },
    { school: '浙江工业大学', degree: '本科', studyMode: '全日制', major: '软件工程', college: '计算机科学与技术学院', start: '2020-09', end: '2024-06', gpa: '3.7/4.0', rank: '前 10%', courses: '数据结构、操作系统、计算机网络、数据库原理' },
  ],
  experience: [
    {
      company: '示例科技（杭州）有限公司',
      title: '后端开发实习生',
      department: '交易平台部',
      city: '杭州',
      start: '2025-07',
      end: '2025-09',
      description: '1. 参与订单服务的接口开发，使用 Spring Boot + MySQL 完成退款查询等 6 个接口；2. 用 Redis 缓存热点数据，把订单详情接口的 P99 延迟从 320ms 降到 90ms；3. 编写单元测试，核心模块覆盖率提升到 80%。',
    },
  ],
  projects: [
    {
      name: '校园二手交易平台',
      role: '后端负责人',
      start: '2023-03',
      end: '2023-06',
      description: '面向本校学生的二手交易小程序后端。负责商品、订单和消息模块的设计与开发，用 MySQL 存储业务数据、Redis 做会话和热门商品缓存，上线后注册用户 2000+。',
      tech: ['Java', 'Spring Boot', 'MySQL', 'Redis'],
    },
    {
      name: '基于大模型的课程问答助手',
      role: '个人项目',
      start: '2024-10',
      end: '2025-01',
      description: '把课程讲义切分后建立向量索引，结合大模型回答课程相关问题，并给出出处页码；用 FastAPI 提供接口，前端用 Vue 实现聊天界面。',
      tech: ['Python', 'FastAPI', '向量检索', 'Vue'],
    },
  ],
  awards: [
    { name: '全国大学生数学建模竞赛', level: '省级', rank: '一等奖', date: '2023-10' },
    { name: '校级一等奖学金', level: '校级', date: '2023-11' },
    { name: 'ACM-ICPC 程序设计竞赛（省赛）', level: '省级', rank: '铜奖', date: '2022-05' },
  ],
  campus: [{ org: '计算机学院学生会', role: '学习部部长', start: '2021-09', end: '2022-06', description: '组织学院编程训练营和期末答疑，累计覆盖 300+ 名同学。' }],
  skills: ['Java', 'Python', 'MySQL', 'Redis', 'Linux', 'Git', 'Docker'],
  languages: [{ name: '英语', level: 'CET-6', score: '560' }],
  certificates: [
    { name: '大学英语六级（CET-6）', date: '2022-06', score: '560' },
    { name: '全国计算机等级考试二级（Python）', date: '2021-09' },
  ],
  jobPreference: { cities: ['杭州', '上海'], positions: ['后端开发工程师', 'Java 开发工程师'], salary: '面议', availableFrom: '2027-07', acceptAdjust: true },
  links: { github: 'https://github.com/example' },
  freeText: {
    selfIntro: '计算机专业硕士在读，有一段后端开发实习经历，熟悉 Java 和 Spring Boot，做过从接口开发到性能优化的完整工作。做事踏实，喜欢把问题查到根上。',
    strengths: '学习速度快；对性能问题敏感，习惯用数据说话；沟通顺畅，在学生会负责过多人协作的活动。',
    careerPlan: '前两年在后端方向打牢基础，深入理解高并发和分布式系统；之后希望成长为能独立负责核心模块的工程师。',
  },
  extra: { 紧急联系人: '林大海（父亲）', 紧急联系人电话: '13900139000' },
}

export const SAMPLE_QA: QA[] = [
  { q: '是否服从调剂', a: '是', updatedAt: 0, source: 'user' },
  { q: '你从哪里得知本次招聘', a: '学校就业网', updatedAt: 0, source: 'user' },
]
