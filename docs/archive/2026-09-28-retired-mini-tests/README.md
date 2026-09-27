# 退役店员演示一致性测试

日期：2026-09-28。状态：历史归档，不在当前测试入口运行。

原 `miniprogram/tests/demo-consistency.test.mjs` 测试已删除的店员工作台演示模块 `features/demo-data.ts`；当前小程序只保留顾客端，继续执行会因模块不存在而失败。
原测试完整保留于本目录的 `demo-consistency.test.mjs`，仅供追溯；相对源码导入是历史路径，不应作为现行测试直接运行。
仍有效的 `display-text.test.mjs` 保留在原测试目录，改从冻结契约读样本，不恢复退役运行模块。顾客演示样本由 customer-fixtures 测试覆盖，商城真实/演示分流由 catalog-runtime 测试覆盖。
