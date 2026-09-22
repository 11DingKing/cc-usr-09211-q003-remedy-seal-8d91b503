# 整改证据封存

文件摘要使用 SHA-256，采集时间保留原偏移；地点为虚构示例。

每次送审把措施、现场记录与文件摘要的关联封存为**不可变证据包**：包内容寻址、只增不改，复核意见绑定检查位置与包版本，现场撤回只能追加撤回记录。大文件分块续传，封存中途进程崩溃不会留下可下载的半包，过期授权重放拿不到原件，损坏内容不会被交给复核员。

## 本地开发

```sh
npm run seed   # 生成虚构样例数据 data/example.json 与 data/source-files/
npm test
npm start      # 默认监听 8080，PORT 环境变量可调整
```

业务数据格式位于 contracts 文件，示例数据位于 data（不入库），接口进程提供 /health 健康探针。数据样例使用虚构编号，不含个人联系方式。数据结构验证不会推断记录的业务结论，未知接口返回 404。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /health | 健康探针 |
| GET | /records | 样例中的措施、现场记录与文件摘要关联 |
| POST | /uploads | 创建分块上传会话（声明 name/size/chunk_size/sha256） |
| GET | /uploads/:id | 续传状态：已收分块 received、缺失分块 missing |
| PUT | /uploads/:id/chunks/:index | 上传分块（请求头 x-chunk-sha256），可乱序、可重复 |
| POST | /uploads/:id/complete | 合并分块并校验整包摘要 |
| POST | /packages | 送审封存：措施+现场记录+文件摘要 → 不可变证据包 |
| GET | /packages | 证据包列表（可按 measure_id 过滤） |
| GET | /packages/:id | 清单与同措施的版本链 |
| GET | /packages/:id/verify | 包完整性校验（重算清单摘要与每个文件摘要） |
| POST | /packages/:id/withdrawals | 现场撤回说明（只追加，不改写已封存包） |
| GET | /packages/:id/withdrawals | 撤回记录列表 |
| POST | /reviews | 复核意见，绑定检查位置 location 与证据包版本 version |
| GET | /packages/:id/versions/:version/reviews | 按包版本重现复核结论 |
| POST | /packages/:id/grants | 签发限时下载授权（file + ttl_seconds） |
| GET | /download/:token | 授权下载，下载前重算摘要，坏包拒付 |

## 异常情形的明确处理结果

| 情形 | 状态码 | code | 结果 |
| --- | --- | --- | --- |
| 分块乱序到达 | 200 | — | 按序号落盘，received/missing 可查 |
| 分块重复（内容一致） | 200 | — | 幂等返回 duplicate，不重复存储 |
| 分块重复（内容不一致） | 409 | CHUNK_CONFLICT | 保留先到分块，拒绝后者 |
| 分块摘要与校验值不符 | 422 | CHUNK_DIGEST_MISMATCH | 分块不保存 |
| 分块未传齐就合并 | 409 | CHUNKS_MISSING | 返回缺失序号列表 |
| 整包摘要不符 | 422 | PACKAGE_DIGEST_MISMATCH | 合并结果废弃，会话置为失败 |
| 封存过程进程中断 | — | — | 半包留在暂存区，重启清扫；任何接口都拿不到（404） |
| 改写已封存包 | 405 | METHOD_NOT_ALLOWED | 拒绝；包只增不改 |
| 复核意见版本不符 | 409 | VERSION_MISMATCH | 拒绝，必须绑定存在的包版本 |
| 授权过期后重放 | 410 | GRANT_EXPIRED | 拒绝提供原件 |
| 伪造/篡改授权 | 403 | GRANT_INVALID | 拒绝 |
| 封存内容损坏后下载 | 409 | INTEGRITY_FAILED | 拒绝把坏包交给复核员 |

## 存储布局（data/store/）

- `staging/uploads/` 分块上传暂存，进程重启后可续传
- `staging/seal/` 封存暂存，启动时清扫
- `blobs/` 内容寻址文件体（按 SHA-256 命名，多包共享去重）
- `packages/<pkg_id>/manifest.json` 不可变清单，登记后才对外可见
- `registry.jsonl` / `reviews.jsonl` / `withdrawals.jsonl` 只追加日志
- `grants.json` 授权记录（原子改写），`secret.key` 授权签名密钥
