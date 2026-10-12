declare const __BUILD_ID__: string
/** 系统提示词（src/prompts/*.md），构建时按文本打包 */
declare module '*.md' {
  const text: string
  export default text
}
