# 场景 2：多文件修改 + 工作区绑定验证

## 目标

验证 Conversation Workspace Binding 正确工作：
- delegate_coding 使用绑定的工作区目录
- 修改发生在绑定目录内
- run_verification 在同一工作区执行
- typecheck 通过

## 前置条件

1. `npm run dev:cline`
2. 在聊天窗口点击 📁 按钮
3. 选择 `scripts/cline-integration-fixture` 作为工作区
4. 确认工作区指示器显示 `cline-integration-fixture`

## 验收任务

发送以下消息给昔涟：

```
请为 scenario2-target.ts 中的 Calculator 类添加一个 power 方法。

要求：
1. power(base: number, exponent: number): number
2. 返回 base 的 exponent 次方
3. 处理 exponent 为负数的情况（返回 1 / base^|exponent|）
4. 处理 0^0 的情况（返回 1）
5. 添加对应的测试用例到新的 test 文件中
```

## 预期行为

### 正确行为

1. **工作区使用**：
   - delegate_coding 使用 `scripts/cline-integration-fixture` 目录
   - 日志显示 `workspaceRoot=C:\Users\13575\Documents\live2D-Cyrene\scripts\cline-integration-fixture`

2. **文件修改**：
   - `scenario2-target.ts` 被修改（添加 power 方法）
   - 可能创建测试文件（如 `scenario2-target.test.ts`）

3. **验证流程**：
   - delegate_coding 返回 `changedFiles` 非空
   - FinalizationGuard 检测到 mutation
   - run_verification 使用同一工作区执行 typecheck
   - typecheck 通过（exitCode=0）

4. **Soul 投影**：
   - 验证通过后，Soul 不引用 `E_FINALIZATION_BLOCKED`
   - Soul 正确报告修改和验证结果

### 错误行为（需要报告）

1. **工作区错误**：
   - delegate_coding 使用了其他目录（如应用源码目录）
   - 日志显示 `WORKSPACE_NOT_BOUND`

2. **验证错误**：
   - typecheck 失败
   - run_verification 使用了不同工作区

3. **Soul 投影错误**：
   - Soul 说"没有修改文件"但实际有修改
   - Soul 说"验证未通过"但实际通过

## 日志检查点

```text
[delegate_coding] command policy: mode=full approved=X denied=0
[delegate_coding] result status=completed changedFiles=["scenario2-target.ts"]
[AgentGraph] mutation evidence: changedFiles=["scenario2-target.ts"]
[AgentGraph] requiredNextAction: run_verification
[AgentGraph] 验证通过: verifiedRevision=1
[AgentGraph] FinalizationGuard: allow_success
```

## 验收后清理

1. 重置 `scenario2-target.ts` 为原始状态
2. 删除创建的测试文件（如果有）
3. 提交验收结果

## 场景 2 通过标准

- [ ] 工作区绑定正确使用
- [ ] 文件修改发生在绑定目录
- [ ] typecheck 通过
- [ ] Soul 投影正确
- [ ] 无环境变量覆盖
