> **状态：暂缓。** 仅当渲染需要拆到独立的本机 worker 时（阶段 F）才启用，当前阶段不要实现。

# Worker 协议 v1

## 认证
所有 /api/video-worker/* 请求带头：

    Authorization: Bearer <WORKER_TOKEN>
    X-Worker-Id: <worker 名称>
    X-Protocol-Version: 1

令牌来自服务器 .env 的 VIDEO_WORKER_TOKEN（哈希比较，常量时间）。
令牌无效返回 401；协议版本不兼容返回 409 `{"error":"protocol_mismatch"}`。

## 任务状态
queued → claimed → running → succeeded | failed

- 租约：claim 时设置 lease_expires_at = now + 300s；每次 progress/heartbeat 续期。
- 租约过期的 claimed/running 任务回到 queued，attempts + 1；attempts ≥ 3 则 failed。
- 幂等：complete 对同一 job_id 重复调用返回同样结果，不重复创建成品。

## 接口

### POST /api/video-worker/heartbeat
- body: `{"worker_version":"0.1.0","capabilities":["ingest_asset","render_video"]}`
- resp: `{"ok":true,"server_time":"..."}`

### POST /api/video-worker/claim
- body: `{"types":["ingest_asset","analyze_music","render_video"],"max":1}`
- resp: `{"job":null}` 或
  `{"job":{"id":"...","type":"...","params":{...},"lease_expires_at":"...","attempts":1}}`

### POST /api/video-worker/jobs/:id/progress
- body: `{"percent":42,"message":"切分镜头"}`
- resp: `{"ok":true,"lease_expires_at":"..."}`

### GET /api/video-worker/files/:fileId
支持 Range 与断点续传，返回原始文件流。

### PUT /api/video-worker/jobs/:id/upload?name=<cover|proxy|output|...>
分片上传：Content-Range 头；最后一片完成后返回 `{"ok":true,"file_id":"..."}`

### POST /api/video-worker/jobs/:id/complete
- body: `{"result":{...}}`（内容随任务类型而定）

### POST /api/video-worker/jobs/:id/fail
- body: `{"error":"...","retryable":true}`

## 任务类型与 params / result

### ping（阶段 0 测试用）
- params: `{"message":"hello"}`
- result: `{"echo":"hello","worker_version":"0.1.0"}`

### ingest_asset
- params: `{"asset_id","file_id","mode":"upload|register_local"}`
- result:
  `{"duration_sec","width","height","fps","has_audio","cover_file_id","proxy_file_id",
  "clips":[{"start","end","description","tags":[],"embedding":[...]}]}`
  （clips 从阶段 2 起填充）

### analyze_music
- params: `{"music_id","file_id"}`
- result: `{"duration_sec","bpm","energy","mood_tags":[]}`

### render_video
- params:
  `{"output_id","product_id","duration_sec",
  "script":[{"text","intent","clip_ids":[],"tts_text"}],
  "bgm_id","bgm_volume_db","voice","subtitle_style","cn_subtitle_mask":{...}}`
- result: `{"output_file_id","cover_file_id","duration_sec","size_bytes"}`
