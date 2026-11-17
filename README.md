# dsh-checkin-skill

为 **DeepSeek Harness (DSH)** 打造的「虚拟定位签到」技能（Skill）。用自然语言说"帮我签到"，Agent 就会自动取登录态、定位、提交，并把结果截图/回执展示给你。

> 定位打卡类自动化，仅用于**操作你本人账号**。自动化可能违反活动方规则，风险由你自负。

## 支持平台

| 平台 | 方式 |
|---|---|
| 群报数 qun100 | 开放接口（微信扫码登录 → 自动定位 → 提交 → 回查） |
| 课堂派 ketangpai | 开放接口（全课程待签到巡检 / 签入签出两段 / GPS 坐标） |
| WPS 表单 | 浏览器 CDP（自动读取打卡围栏中心、GCJ-02 反算、注入虚拟定位） |
| 小小签到 xiaoqiandao | 微信扫码登录 + H5 接口签到（位置签到走浏览器注入定位） |
| 通用网页表单 | 自动识别姓名/学号输入框 + 虚拟定位 + 提交 + 截图 |
| 微信小程序 / App | 抓包后用通用接口回放（`{{lat}}/{{lng}}/{{student}}/{{ts}}` 模板） |

## 特性

- **零第三方依赖**：只用 Node 内置 `fetch` / `WebSocket` / `child_process`。
- **自动取 token**：浏览器登录自动读取，或群报数微信扫码；不让用户翻开发者工具。
- **自动定位**：优先用表单/围栏接口给的坐标；否则联网地理编码；再 `inside` 自检范围。**无需用户手输经纬度。**
- **坐标纠偏**：WGS84 / GCJ-02 / BD-09 互转，避免 100–700 米级偏移导致"不在打卡范围"。
- **结果可见**：返回中文小结 + 截图/回执图片路径。
- **Agent 友好**：每条命令输出一段 JSON（含 `summary`），退出码稳定。

## 目录结构

```
dsh-checkin-skill/
├─ README.md
├─ LICENSE
├─ .gitignore
└─ checkin/                 ← 把整个目录拷到 ~/.dsh/skills/ 即可
   ├─ SKILL.md              ← 技能说明（加载时给 Agent 的提示词）
   ├─ references/API.md     ← 各平台接口逆向速查
   └─ scripts/
      ├─ checkin.mjs        ← 统一 CLI
      └─ lib/               ← geo / qun100 / ketangpai / wps / webform / apireplay / cdp / receipt
```

## 安装

DSH 会自动发现用户技能目录（`~/.dsh/skills/<name>/SKILL.md`）。直接把 `checkin/` 放进去即可，无需安装插件、无需改 profile：

```powershell
# Windows
git clone https://github.com/<you>/dsh-checkin-skill
Copy-Item -Recurse .\dsh-checkin-skill\checkin "$env:USERPROFILE\.dsh\skills\checkin"
```

```bash
# macOS / Linux
git clone https://github.com/<you>/dsh-checkin-skill
cp -r dsh-checkin-skill/checkin ~/.dsh/skills/checkin
```

放好后新开一个会话，技能目录里就会出现 `checkin`；也可以直接 `/checkin` 调用。

## 环境要求

- Node.js **≥ 22**（内置 WebSocket / fetch）。
- 浏览器类功能需要本机有 **Chrome / Edge**（接口类功能不需要）。
- 地理编码想更准可配高德 key：`AMAP_KEY`（免费申请）。

## 快速开始

```powershell
$c = "$env:USERPROFILE\.dsh\skills\checkin\scripts\checkin.mjs"

node $c doctor                       # 自检：node / 浏览器 / 登录态 / 网络
node $c --version

# 登录态
node $c token login --platform ketangpai --timeout-ms 180000
node $c qun100 login-qr              # 群报数出二维码
node $c qun100 login-poll

# 签到
node $c qun100  inspect --url "<二维码链接>"
node $c qun100  sign    --url "<链接>" --student 20230000
node $c ketangpai pending
node $c ketangpai sign
node $c wps     locate  --form-url "https://f.wps.cn/ksform/cw/w/XXXX"
node $c wps     sign    --form-url "..." --name 张三 --student-id 20230000
node $c web     --url "https://..." --name 张三 --student-id 20230000

# 小小签到（微信小程序型，H5 接口 + 扫码登录）
node $c xiaoqiandao login-qr
node $c xiaoqiandao login-poll
node $c xiaoqiandao list
node $c xiaoqiandao detail --url "https://m.xiaoqiandao.com/detail?cid=<24位hex>"
node $c xiaoqiandao sign   --url "https://m.xiaoqiandao.com/detail?cid=<24位hex>"
```

命令分组：`doctor | guide | token | geo | browser | qun100 | ketangpai | wps | web | api | sign`。
每组的动作与参数见 [checkin/SKILL.md](checkin/SKILL.md)。

## 定位与坐标

- 微信 / 高德 / 腾讯 = **GCJ-02**；GPS / Google = **WGS84**；百度 = **BD-09**。
- 混用会偏 100–700 米，直接导致"不在打卡范围"。用 `geo convert` 明确转换。
- WPS 表单围栏是 GCJ-02，但浏览器 `navigator.geolocation` 按 WGS84 语义，脚本已内置反算。

## 登录态与隐私

- token / Cookie 存在本机 `~/.dsh/checkin/state.json`（可用 `CHECKIN_STATE_DIR` 改目录），**不进仓库、不写日志、不对外回显（仅掩码）**。
- 本仓库不含任何用户数据。

## 免责声明

本项目仅供学习与技术研究，用于自动化操作**你本人**的账号；不提供代签、多账号群签、绕过身份验证。使用前请确认所在单位/平台允许此类自动化，后果自负。

## License

MIT
