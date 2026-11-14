# AGENTS.md

DSH 每个会话启动时会自动读取本文件。在本仓库（`dsh-feishu-wms`）工作的 agent 请先读这一节。

## 这是什么

一个 DSH 插件 bundle，实现「鞋类采购报送管理系统」：
飞书消息 → Agent 语义解析 → 订单入库 → 当日汇总 / 出库 PDF / 月度结算 PDF。

- 宿主：`lib/index.js`（工具 + HTTP 路由 + 角色权限 + 系统提示段）
- 数据层：`lib/store.js`（JSON 原子写，默认 `~/.dsh/feishu-wms/db.json`）
- 解析：`lib/parse.js`（确定性预解析，Agent 语义理解之外的兜底与可测部分）
- PDF：`lib/pdf.js`（pdfkit + fontkit 字体能力校验）
- 后台面板：`lib/panel.html`（每次请求实时读取）
- DSH 设置页入口：`lib/client.js`（Client 插件）

## 硬性约定

1. **不要**把 `dsh` 的 HMR root 指到本仓库。本插件已在 `web` profile 里以 junction 安装
   （`~/.dsh/profiles/web/node_modules/dsh-feishu-wms` → 本仓库），指过去同样会形成目录环。
   改完 Host 代码就重启 `dsh web`；改面板刷新浏览器即可。
2. 数据只在 `~/.dsh/feishu-wms`，不要把它当源码提交；测试用 `WMS_DATA_DIR` 指到临时目录。
3. 订单**只追加**：需求明确「修改 / 作废」暂不包含，不要顺手加 update/delete 订单能力。
4. 解析失败 / 字段不全时**不要入库**，只写 `pending` 并返回追问话术。
5. 新增工具或路由时，同步更新 `scripts/verify-requirements.mjs` 与 `test/*.test.mjs`，
   否则需求矩阵会失真。

## 常用命令

```powershell
npm test                 # 40 个测试（parse / store / pdf / plugin 集成）
npm run verify           # 需求追溯矩阵（22 项，PASS/FAIL）
npm run e2e              # 对 127.0.0.1:3080 的只读端到端检查
npm run e2e -- --write   # 连写入链路一起验（会往线上库写 e2e- 前缀的测试数据）
```

## 装机 / 排障

```powershell
# 安装或重新安装（DSH 会话里让 Agent 执行也行）
dsh plugin --profile web add link:<repo-path>

# 检查是否活着
curl http://127.0.0.1:3080/api/wms/health
curl http://127.0.0.1:3080/api/wms/panel
```

- 如果 `plugin_manager install_bundle` 报 `timed out waiting for the writer lock`：
  `~/.dsh/profiles/web/package.json.lock` 是 0 字节的陈旧锁（atomic-write 无法接管空记录），
  确认没有其他安装进程后删掉该文件再重试。
- PDF 中文变方框/缺字：说明没找到可嵌入的中文字体（`.ttc` 集合不被 pdfkit 支持）。
  用 `WMS_PDF_FONT` 指定一个 `.ttf`（如 `C:/Windows/Fonts/simhei.ttf`）。
- 工具在旧会话里看不到：工具新注册只对新会话 / 新请求生效，刷新页面或新建会话。

## 验证报告

需求逐条验收结论见 [`docs/需求验证报告.md`](docs/需求验证报告.md)。
