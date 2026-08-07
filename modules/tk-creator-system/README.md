# TikTok 达人管理系统 — 安装与运行说明

这是一个独立运行的系统，使用 Node.js + 内置 SQLite 数据库，包含「样品中心」和「合作达人库」两大功能模块。

**重要：** 这个版本使用 Node.js 自带的数据库功能（`node:sqlite`），**不需要安装任何数据库相关的包，不需要装编译工具**。只需要 Node.js 版本是 **22 或更高**（用 `node -v` 查看，你之前的截图显示是 v24，完全没问题）。

---

## 第一步：把文件夹放到你的电脑上

把整个 `tk-creator-system` 文件夹复制到你电脑的任意位置，比如：
```
C:\Users\Administrator\Desktop\tk-creator-system
```

---

## 第二步：安装依赖包

打开 VS Code，用 **File → Open Folder** 打开 `tk-creator-system` 文件夹。

按 `Ctrl + ~` 打开终端，输入：

```bash
npm install
```

这一步只会下载一个叫 `express` 的包（几秒钟就好），不会再卡在编译 SQLite 那一步了。

---

## 第三步：启动系统

在终端继续输入：

```bash
npm start
```

看到下面的提示就说明启动成功了：

```
🚀 TikTok达人管理系统已启动
   本机访问： http://localhost:8787
   局域网访问：http://<这台电脑的IP>:8787
```

如果看到一行黄色的 `ExperimentalWarning: SQLite is an experimental feature`，**这是正常的**，不是报错，可以忽略。这只是 Node.js 提示这个数据库功能还比较新。


---

## 第四步：在浏览器打开

打开浏览器，输入：

```
http://127.0.0.1:8787
```

或者：

```
http://localhost:8787
```

就能看到系统界面了。

---

## 第五步：让同事也能访问（局域网共享）

### 5.1 查看你电脑的局域网 IP

在终端（新开一个终端窗口，不要关掉正在运行的服务）输入：

```powershell
ipconfig
```

找到 **「无线局域网适配器 WLAN」** 或 **「以太网适配器」** 下面的 **IPv4 地址**，类似：

```
IPv4 地址 . . . . . . . . . . . . : 192.168.1.5
```

### 5.2 告诉同事访问的地址

同事在同一个 WiFi / 局域网下，浏览器输入：

```
http://192.168.1.5:8787
```

（把 `192.168.1.5` 换成你自己电脑实际的 IP）

### 5.3 检查防火墙（如果同事打不开）

Windows 防火墙可能会拦截外部访问，需要放行 8787 端口：

1. 打开「控制面板 → 系统和安全 → Windows Defender 防火墙 → 高级设置」
2. 左侧点「入站规则」→ 右侧点「新建规则」
3. 选择「端口」→ 下一步
4. 选择「TCP」，特定本地端口填 `8787` → 下一步
5. 选择「允许连接」→ 一路下一步 → 名称随便填，比如「TK达人系统」

---

## 数据存在哪里？

所有数据保存在：
```
tk-creator-system/data/tk-creator.db
```

这是一个 SQLite 数据库文件。首次启动时会自动创建，并写入一些演示数据（2 个店铺、4 个 BD、16 条样品申请记录），方便你直接看效果。

**重要：** 这个 `.db` 文件就是你的全部数据，记得定期备份（直接复制这个文件就是备份）。

---

## 系统目前已实现的功能

### 样品中心
- 双店铺（OKUYOSHI / MIR HOME）切换查看，支持「全部」汇总视图
- 顶部统计卡片（待审核、申请总数、已分配BD、已寄出、已发布）实时联动当前店铺
- 状态 Tab 筛选（全部/待审核/已分配/已寄出/已发布/已拒绝）
- 搜索达人名称、按合作类型筛选
- 点击「通过/拒绝」直接写入数据库
- 点击合作类型标签可现场修改（公开/定向/联盟）
- 点击「分配BD」选择负责人，控制台会打印通知日志
- 「新建样品申请」表单手动录入数据

### 合作达人库
- 只展示已通过审核的达人（approved/assigned/shipped/published）
- **按达人 UID 自动合并**——同一达人在两个店铺的申请记录会合并显示在一张卡片里，标注「双店铺合作」
- 展开卡片查看每次样品申请的详情子表格
- 1-5 星评级，点击星星即可保存到数据库
- BD 跟进备注可编辑保存

### BD 成员管理
- 查看所有 BD 及其当前负责的达人数量（按 UID 去重统计）
- 新增 BD 成员

---

## 下一步可以做什么

这个版本是**手动操作 + 真实数据库存储**的完整可用系统，后续可以在这个基础上逐步加：

1. **接入 TikTok Shop 真实 API** —— 替换"新建样品申请"为自动从 TikTok 后台拉取
2. **Webhook 实时推送** —— 新样品/新订单自动写入，无需手动点「刷新」
3. **数据中心模块** —— BD月报、出单统计、自动通知规则

### BD 报表指标口径

接口：`GET /api/data/bd-report?bd=all&period=month&shop=all`。三个筛选条件共同作用于指标卡、明细表和图表；时间按自然月，BD 优先取 `samples.bd_id`，为空时取 `creator_library.bd_id`。

| 指标 | 数据表和字段 | 聚合口径 |
| --- | --- | --- |
| 新增定邀达人 | `samples.uid/collab_type/applied_at` | 时间段内 `collab_type = 'targeted'` 的去重达人 |
| 新增公开邀约 | `samples.uid/collab_type/applied_at` | 时间段内 `collab_type = 'open'` 的去重达人 |
| 总负责达人数 | `samples.uid/bd_id`, `creator_library.bd_id` | 截止期末已归属所选 BD 的去重达人 |
| 邀约接受率 | `samples.uid/collab_type/status` | 定邀中状态为 `approved/assigned/shipped/published` 的去重达人数 / 定邀去重达人数 |
| 新增样品合作 | `samples.id/status/applied_at` | 时间段内状态为 `approved/assigned/shipped/published` 的合作记录数 |
| 达人履约率 | `samples.uid/sample_received_at/published_at` | 签收后 7 天内发布的去重达人数 / 已签收去重达人数 |
| 视频发布数量 | `samples.id/status/published_at` | 时间段内变为 `published` 的合作记录数，一条合作记录计一个视频 |
| 订单转化量 | `affiliate_orders.external_order_id/creator_username/order_created_at` | 按达人账号关联 BD 后，对时间段内订单号去重计数 |

新达人指该 `uid` 的本次 `samples.applied_at` 等于全库最早样品合作时间；老达人指此前已有更早的 `samples` 记录。首次合作判断跨店铺。报表请求直接聚合 `data/tk-creator.db`，不使用前端模拟数据。
4. **登录权限** —— 区分管理员和 BD 账号，BD 只能看到分配给自己的达人
5. **超时提醒 / 自动星级规则** —— 定时任务自动检测、自动打标

---

## 遇到问题？

| 现象 | 可能原因 | 解决方法 |
|------|---------|---------|
| `npm install` 报错，提示找不到 node-gyp / Visual Studio | 这是旧版本遗留问题 | 用现在这个最新版本不会再出现，因为已经不需要编译任何东西了 |
| `npm start` 后提示 `node:sqlite` 相关错误 | Node 版本太低 | 输入 `node -v` 确认版本是 v22 以上，低于这个版本需要去 nodejs.org 重新下载安装最新版 |
| `npm start` 后立刻退出，提示端口占用 | 8787端口被占用 | 修改 `server.js` 里的 `const PORT = 8787` 改成别的数字，如 8788 |
| 同事访问不了 | 防火墙拦截 | 按上面"5.3"步骤放行端口 |
| 页面打开是空白 | 浏览器缓存 | 按 `Ctrl + Shift + R` 强制刷新 |
| 数据全部丢失/重置 | `data/tk-creator.db` 被误删 | 没有删的话数据一直都在；建议定期复制这个文件备份 |
