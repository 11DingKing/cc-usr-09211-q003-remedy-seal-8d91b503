# 整改证据封存

乡镇基础设施复核场景下，让每次送审形成**不可变证据包**：措施、现场记录、检查位置与每个文件的 SHA-256 摘要在封存时绑定为一个版本；分块续传支持乱序与断点；撤回只能追加记录；补交生成新包，原复核结论仍可完整重现；下载必须持一次性授权票据，出件前逐文件重算摘要，坏包绝不交给复核员。

文件摘要使用 SHA-256，采集时间保留原偏移；地点、编号、人员均为虚构示例。

## 目录

- `contracts.mjs` — 送审/复核数据结构、规范化序列化（canonical JSON）、整包摘要
- `store.mjs` — 封存引擎：仅追加事件日志、暂存/封存双区、原子封存、崩溃对账、票据
- `service.mjs` — HTTP 接口
- `client.mjs` — 送审端辅助（分块规划、乱序上传）
- `scripts/seed.mjs` — 生成虚构样例（`data/example.json` 与 `data/raw/` 原件）
- `scripts/demo.mjs` — 端到端演示（含损坏分块/坏包拒绝实证）

## 本地开发

```sh
npm run seed   # 生成虚构样例（确定性内容，重复执行摘要不变）
npm test       # 13 项测试
npm run demo   # 端到端演示：乱序/重复/损坏、封存、撤回、复核、补交、授权与拒绝
npm start      # 服务默认监听 8080，PORT 改端口，SEAL_ROOT 改数据目录
```

## 不可变性如何保证

- **双区布局**：`staging/<pkg>/` 是可续传暂存区，任何接口都不提供下载；`sealed/<pkg>/` 是唯一可下载区。封存先在 `sealed/<pkg>.tmp-*` 组装清单签名与原件，再整目录 `rename`，成功才对外可见。进程中断只可能留下 `tmp-*` 半包，重启对账时清除。
- **清单签名**：封存清单为 canonical JSON，附 HMAC-SHA256 签名（`secret`，权限 600）；任何字段被改写都会在校验时暴露。
- **只追加**：撤回、复核写入包内 `records.jsonl` 与全局 `events.log`，从不回改已封存字节与清单；事件日志缺失时，以封存包目录为权威恢复。
- **内容寻址版本**：包编号与版本为送审内容（措施、位置、文件摘要、补交链）的 SHA-256；补交材料必然得到另一个包，原包保持原样，版本链通过 `supersedes / superseded_by` 双向关联。

## 分块上传的明确处理结果

| 情形 | 结果 |
|---|---|
| 乱序上传 | 按 `(文件序号, 分块序号)` 定位，全部到齐后按序号顺序组装 |
| 重复上传相同内容 | `200 duplicate_ignored`，幂等不覆盖 |
| 分块长度不符 | `422 chunk_length_mismatch`（给出期望/实际字节数） |
| 分块摘要不符 | `422 chunk_corrupt`（不落盘，给出期望/实际 SHA-256） |
| 用不同内容覆盖已收块 | `409 chunk_conflict`，拒绝覆盖 |
| 组装后整文件摘要不符 | `422 file_digest_mismatch`，不能进入封存 |
| 封存时整包摘要漂移 | `422 package_digest_mismatch` |
| 断点续传 | `GET /packages/:pkg` 返回 `received_chunks / missing_chunks`；`DELETE` 单块可重置后重传 |

## 接口

```
POST   /packages                                   送审建包（含分块摘要清单）
GET    /packages/:pkg                              续传状态 / 封存后含复核与撤回记录
PUT    /packages/:pkg/files/:fi/chunks/:ci         上传分块（原始字节）
DELETE /packages/:pkg/files/:fi/chunks/:ci         重置分块
POST   /packages/:pkg/files/:fi/assemble           顺序组装并校验整文件摘要
POST   /packages/:pkg/seal                         原子封存
GET    /packages/:pkg/verify                       包完整性校验（逐文件重算摘要）
GET    /packages/:pkg/manifest                     封存清单（含签名版本号）
POST   /packages/:pkg/reviews                      复核意见（必须绑定 check_site）
POST   /packages/:pkg/withdrawals                  现场撤回说明（仅追加）
POST   /packages/:pkg/tickets                      签发授权票据（默认 300s）
GET    /download/:pkg?token=…&file=f000            一次性授权下载
GET    /health
```

复核意见记录形如：

```json
{
 "review_id": "RV-0001",
 "package_version": "pkg_46ed…@46ed…（包@整包摘要）",
 "reviewer": "周复核", "decision": "approved",
 "opinion": "排水沟断面尺寸与照片一致，同意通过。",
 "check_site": {"name": "青山乡·云岭村三组路口", "code": "QS-YL-03", "...": "..."},
 "created_at": "2026-09-22T09:40:00+08:00"
}
```

## 授权下载

票据为 HMAC 签名的 `{pkg, jti, iat, exp}`，**一次性**且**绝对过期**：下载核销前先跑整包完整性校验。过期重放返回 `410 ticket_expired`，已用重放返回 `409 ticket_replayed`，签名伪造返回 `401 bad_token`，跨包使用返回 `401 ticket_scope_mismatch`，包损坏返回 `410 package_corrupt`。

`npm run demo` 的第 7 步会真实翻转一个封存原件的字节，展示完整性校验报出具体损坏文件，且即使持有刚签发的有效票据也拒绝出件。
