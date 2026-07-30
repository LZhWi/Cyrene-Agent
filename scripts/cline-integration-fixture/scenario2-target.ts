/**
 * 场景 2 验收目标文件
 *
 * 任务：为 Calculator 类添加一个 power 方法（幂运算）
 *
 * 验收要求：
 * 1. delegate_coding 必须使用 Conversation Workspace Binding 的目录
 * 2. 修改必须发生在本文件（不是其他目录）
 * 3. run_verification 必须在同一工作区执行
 * 4. 最终 typecheck 通过
 */

export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }

  divide(a: number, b: number): number {
    if (b === 0) throw new Error("Division by zero");
    return a / b;
  }

  // TODO: 添加 power(base, exponent) 方法
  // 要求：
  // - base: 底数
  // - exponent: 指数
  // - 返回 base 的 exponent 次方
  // - 处理 exponent 为负数的情况
  // - 处理 0^0 的情况（返回 1）
}
