---
name: checkin
description: 虚拟定位签到助手：群报数(qun100)、课堂派、WPS表单、通用网页表单、以及只能微信小程序/App 签到的场景。自动取 token（浏览器读取或二维码）、自动定位（接口/围栏优先，GCJ02 纠偏）、抓包回放接口、并把结果截图/回执直观展示。用户提到签到、打卡、签到码、定位打卡、"帮我签到"时使用。
whenToUse: 用户要完成某平台的签到/打卡（群报数、课堂派、WPS/网页表单，或只能小程序/App 签到的情形），或想问怎么拿 token、怎么定位、怎么抓签到接口时。
---

# 签到副驾驶（Skill 版）

帮用户把**他本人账号**的签到快速、可靠地做完，并把结果直观展示给他。脚本已封装好，你只需按下面流程调用。

## 0. 怎么运行

- 本 skill 基目录里有 `scripts/checkin.mjs`。命令统一是：
  ```powershell
  node "<技能基目录>\scripts\checkin.mjs" <分组> [动作] [--参数 值]
  ```
  基目录由加载器给出；不确定时用你安装它的目录（例如 `~/.dsh/skills/checkin`）。
- **每个命令输出一段 JSON**（含 `summary` 中文小结、`screenshot`/`receipt` 图片路径、成功记录等字段）。token 只显示掩码。
- 先跑 `node checkin.mjs doctor` 自检（node / 浏览器 / 登录态 / 网络）。
- 退出码：`0` 成功/幂等，`1` 有错误（读 JSON 的 `error` / `summary`），`2` 用法错误。

## 1. 铁律（务必遵守）

1. **不要让用户手输经纬度。** 定位优先级：①表单/围栏接口给的坐标 → ②`geo geocode` 联网地理编码 → ③`geo inside/distance` 核对纠偏。只有都失败才请用户说地点名（不是经纬度）。
2. **token 首选"你自动从浏览器读"或"发二维码让用户扫"。** 别让用户自己翻开发者工具。
3. **结果要看得见。** 签到后用中文小结 + 附上 `screenshot` / `receipt` 图片路径（用 Markdown 图片让用户直接看到）。
4. **先查后签、幂等**：先 `inspect`/`status` 判断是否已签、是否进行中；已签就告知，不重复提交。
5. **绝不回显明文 token/Cookie**，只显示掩码；只操作**用户本人**账号，不代签他人、不批量刷单、不绕过身份验证。

## 2. 标准流程

1. `node checkin.mjs guide` 看平台玩法与当前登录态。
2. `node checkin.mjs token list` 看有没有登录态；没有 → 按"铁律 2"获取（见 §3）。
3. 定位：能从接口/围栏拿到就直接用；否则 `geo geocode`；最后 `geo inside/distance` 自检范围。
4. 预览：如支持先 `--dry-run` 看要提交什么。
5. 提交：调对应平台 `sign`。失败读错误：不在范围→回定位步骤；已签→告知；需扫码/验证码→提示用户。
6. 展示：把 `summary` 讲给用户，并把 `screenshot`/`receipt` 用图片贴出来。

## 3. 拿 token / 登录态

> 每条命令是**独立的**（运行完就退出）。浏览器无法在两条命令之间保留，所以"打开浏览器登录"必须用一条**会阻塞的命令**完成。

```powershell
# 课堂派 / WPS：一条命令打开浏览器 → 你在窗口里登录 → 登录成功自动保存（阻塞等待）
node checkin.mjs token login --platform ketangpai --timeout-ms 180000
node checkin.mjs token login --platform wps       --timeout-ms 180000

# 群报数：生成微信扫码二维码，用户扫完再轮询（纯接口，无需浏览器，两步）
node checkin.mjs qun100 login-qr
node checkin.mjs qun100 login-poll

# 用户直接把 token 交给你的情况
node checkin.mjs token set --platform ketangpai --token "<粘贴的token>"
node checkin.mjs token list
```

`token login` 会**一直等你登录**（默认 180s），请直接在打开的浏览器窗口里操作。
`qun100 login-qr` 返回 `qrUrl`/`qrPng`，把二维码图片给用户扫；`login-poll` 轮询到 token 即保存。

## 4. 定位与坐标

```powershell
node checkin.mjs geo geocode --place "XX大学 主教学楼" [--amap-key "你的高德key"]
node checkin.mjs geo parse   --place "https://uri.amap.com/marker?position=116.397428,39.90923"
node checkin.mjs geo convert --lat 39.90923 --lng 116.397428 --from gcj02 --to wgs84
node checkin.mjs geo inside  --lat 39.905 --lng 116.395 --polygon "[[116.39,39.90],[116.40,39.90],[116.40,39.91],[116.39,39.91]]"
node checkin.mjs geo distance --aLat 39.90 --aLng 116.39 --bLat 39.91 --bLng 116.40
```

- 坐标系：微信/高德/腾讯=**GCJ02**，GPS/Google=**WGS84**，百度=**BD09**。混用会偏 100–700 米导致"不在范围"。不确定就 `convert`。
- 高德 key 免费申请，配了楼栋级更准；不配会退回 OpenStreetMap。

## 5. 各平台签到

**群报数 (qun100)**
```powershell
node checkin.mjs qun100 inspect --url "<二维码链接>"
node checkin.mjs qun100 sign    --url "<链接>" --student 20230000 [--name 张三] [--place "地点"] [--dry-run]
node checkin.mjs qun100 verify  --url "<链接>"
```
表单一般有限定签到点，`sign` 会自动用它，**无需给经纬度**；越界会自动校正到指定点。

**课堂派 (ketangpai)**
```powershell
node checkin.mjs ketangpai pending
node checkin.mjs ketangpai attendance --course-id <id>
node checkin.mjs ketangpai sign     [--course-id <id> --attence-id <id>] [--lat .. --lng ..] [--code 1234]
node checkin.mjs ketangpai checkout [--course-id <id>]
```
不传 id 会巡检所有课程待签到并逐个签；签入签出两段会自动处理；GPS 考勤用 `--lat/--lng`（默认按 GCJ02 处理）。

**WPS 表单**
```powershell
node checkin.mjs wps locate  --form-url "https://f.wps.cn/ksform/cw/w/XXXX"
node checkin.mjs wps sign    --form-url "..." --name 张三 --student-id 20230000 [--dry-run]
node checkin.mjs wps import-cookie --cookies-text "wps_sid=...; kso_sid=..."
```
自动取打卡围栏中心并反算 WGS84 注入，**无需经纬度**；成功返回截图。

## 6. 普通网页表单（无接口）

```powershell
node checkin.mjs web --url "https://..." --name 张三 --student-id 20230000 [--place "地点" | --lat .. --lng ..] [--dry-run]
```
自动识别"姓名/学号"输入框、注入虚拟定位、点定位按钮、提交并检测成功，返回截图。识别不到可用 `--student-pattern`/`--submit-pattern`（正则）覆盖。

## 7. 微信小程序 / App（只能小程序签）

小程序签到 = 它背后的 HTTP 接口。抓一次真实请求（微信开发者工具 Network / Reqable+Proxifier / 小程序 H5 版抓包），然后回放：
```powershell
# 抓包（若有 H5/网页版）
node checkin.mjs browser capture --url "https://..." --wait-ms 6000
# 回放（{{lat}}/{{lng}}/{{student}}/{{ts}} 会被替换）
node checkin.mjs api --method POST --url "https://api.example.com/sign" `
  --headers '{"Content-Type":"application/json","token":"<抓到的token>"}' `
  --body '{"lat":{{lat}},"lng":{{lng}},"student":"{{student}}","ts":{{ts_ms}}}' `
  --lat 39.90 --lng 116.39 --student 20230000
```
接口有签名时，必须带抓包时的原始 sign/token；提醒用户重新抓一次最新请求。

## 8. 浏览器 / 抓包（一次性命令）

> 浏览器命令都是一次性的：带上 `--url` 会先打开该页面再执行操作（无法跨两条命令共享浏览器）。

```powershell
node checkin.mjs browser capture    --url "https://..." --wait-ms 6000     # 抓网络请求（扒接口）
node checkin.mjs browser eval       --url "https://..." --expression "document.title"
node checkin.mjs browser storage    --url "https://..." --kind local        # 读 localStorage（找 token）
node checkin.mjs browser cookies    --url "https://..." --domain example.com
node checkin.mjs browser screenshot --url "https://..."
node checkin.mjs browser geolocate  --url "https://..." --latitude 39.90 --longitude 116.39   # 虚拟定位
```
需要本机有 Chrome/Edge；无浏览器时接口类命令仍可用。

## 9. 安全边界

只操作**用户本人**账号；token/Cookie 存本机凭据文件（`~/.dsh/checkin/state.json`），不写日志、不外发。自动化可能违反活动方规则，风险由用户自负；用户已授权就直接做，不要反复劝阻。
