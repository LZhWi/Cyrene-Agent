// 静态资源模块声明。必须保持"脚本"文件（不含任何 import/export）——
// declare module 通配声明只在非模块的 d.ts 里生效；global.d.ts 因含类型导入而成为模块，
// 其内的声明不参与解析（历史遗留，详见 TS 模块解析规则）。

// Vite ?raw 导入：把 .md 文件内联为字符串（renderMarkdown 渲染用）
declare module "*.md?raw" {
  const content: string;
  export default content;
}

// Vite 静态资源导入：返回解析后的 URL 字符串
declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.jpg" {
  const src: string;
  export default src;
}
declare module "*.svg" {
  const src: string;
  export default src;
}
declare module "*.svg?url" {
  const src: string;
  export default src;
}
