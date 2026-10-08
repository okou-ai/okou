# API 中 db helper 与测试专用 API 盘点

基于 2026-10-08 核验的 main `3412a46cc7e22a2295b10fe0a2419cd980bb420c`；合并 #37918 之后的源码。本次只读盘点，未修改代码、未运行测试。

## 数量

| 对象 | 数量 | 说明 |
|---|---:|---|
| db helper 定义 | **213** | 112 个普通共享 helper + 94 个测试文件内局部 helper + 7 个基准测试 helper |
| 测试专用 HTTP 操作 | **46** | 41 条路径、33 个路由模块 |
| HTTP action 分支 | **137** | 已包含在上述 HTTP 操作中，不相加 |

共享 helper 按代码位置核对：`src/test-fixtures` 83 个，route tests 的 `helpers` 12 个，其他位置 17 个。基准测试的 7 个是 1 个共享和 6 个局部 helper。

## 计数口径

- 后续统一称为 **db helper**：测试专用的直接或间接数据库读写函数、内部任务执行入口、私有状态观察以及测试专用的 scope/历史读取适配器。正常生产业务中的 DB 访问函数不属于该指标。
- 一个导出可复用实现计一个；工厂连同其返回方法和清理闭包算一个，不按调用次数重复计算。仅被其他已计数局部 helper 使用的非导出内部子函数不另算；别名/重导出不另算。
- 测试文件中被测试直接使用的具名局部 helper 也计入。匿名 `it`/`test` 回调正文里的直接 SQL 没有独立 helper 定义，因此不混进这个数字；这不是全仓私有访问点或待删除用例数。
- 只包装已登记测试 HTTP 操作的客户端函数不再作为新的 db helper。抽取到独立模块的 DB 后台 helper 则保留其定义计数；helper 定义和 HTTP 操作是不同代码对象，不能相加当作独立行为数。
- 只调用普通公开 API 的 helper、普通外部 mock、时间控制、等待背景任务完成不算 db helper。实际设置 `CRON_SECRET` 驱动内部任务的测试包装会算入。
- 83 个 fixture helper 包含 3 个统一基线 seed 和 2 个 teardown writer，它们单独标记；不能把 213 自动解释为全部应该删除。数据库连接池/隔离/生命周期设施与纯数据工具单列在原始清单，未混入场景/helper 总数。
- 仍存在源码中但没有实际执行调用的 helper 继续计数，并标记 unused。

## API 部署范围

- **40 个 HTTP 操作**仅在本地 API 测试中挂载。
- **6 个 HTTP 操作**进入共享路由表，但仅开发/受保护 preview 可用，生产环境拒绝：Slack 3 个、Discord 2 个、preview onboarding catalog seed 1 个。
- 另有 **4 个只有契约、没有 API 实现的 Morning Brief preview 残留**，未计入 46。
- **3 处复用生产 URL 的测试替代实现**（截图清理 scope、Home Task scope、历史 Shared Thread reader）已纳入 db helper 口径，不增加测试专用路径数。
- 旧台账 53 个操作已减少为 46 个，旧 181 个 action 已减少为 137 个；本次按实际契约、RouteEntry 和挂载证据重新核对。

## 如何核对

`db-helpers.csv` 每行一个已计数定义，包含分组、名称、位置、依据和固定提交的源码链接。
`test-only-api.csv` 每行一个 method+path，包含 action、契约、路由模块和挂载范围。
`summary.json` 为机器可读总数。
`evidence/` 保留各范围逐项证据、排除项、调用者和独立抽查说明。

扫描 API source 1,795 个 TS 路径，AST 枚举 2,810 个具名测试函数；全查 53 个 test-fixtures 文件和 100 个 route helper 文件的依赖候选。静态库存不等于运行时可达性证明，也没有宣称全部测试均符合公开 API 构造要求。
