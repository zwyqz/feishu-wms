# Contributing

感谢你愿意改进 `dsh-feishu-wms`。这个项目的定位很窄：把「飞书接单 → 订单入库 → 当日汇总 → 出库 PDF → 月度结算」这条链路做稳，而不是扩成通用 WMS。

## 开发环境

- Windows 10/11（当前主要开发和验证平台）
- Node.js `^22.19.0 || >=24.0.0`
- 一台装有 Microsoft Edge 的机器（面板预览不强制要求）

```powershell
npm install
npm test          # 40 个单测 + 集成测试
npm run verify    # 22 项需求追溯矩阵
npm run preview   # 隔离预览面板（端口 3099，不碰线上数据）
```

## 提交前

1. 跑通 `npm test` 与 `npm run verify`，两项都必须 0 FAIL。
2. 新增工具或路由时，同步更新 `scripts/verify-requirements.mjs` 和对应的 `test/*.test.mjs`，否则需求矩阵会失真。
3. 新增字段或行为时，同步更新 `README.md` 和 `docs/需求验证报告.md`。
4. 不要提交 `node_modules/`、业务数据 `db.json`、导出目录 `exports/` 或任何真实客户信息。

## 设计约定

- **订单只追加**：需求明确「修改 / 作废」暂不包含，不要顺手加 update/delete 订单能力。
- **不确定就不入库**：解析失败或字段不全时只写 `pending` 并返回追问话术。
- **规则兜底，模型增强**：确定性解析器负责可复现与可测试，Agent 负责口语化理解。
- **鉴权在服务端**：角色能力表在 `lib/index.js`，不要只在前端隐藏按钮。
- **验证只看状态**：URL、HTTP 状态码、PDF 字节标记、需求矩阵，而不是截图和标题栏。

## 提交信息

使用 Conventional Commits 风格，例如：

```text
feat: 支持同一消息内多行订单
fix: 修复尺码正则误吞 43.5
docs: 补充 PDF 字体探测说明
```
