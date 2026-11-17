# 接口速查（逆向结论）

## 群报数 qun100
- 业务域名：`https://form.qun100.com`（不是 www / fastformapi）
- 鉴权头：`Authorization: <token>`（无 Bearer）；token 由微信扫码登录接口下发
- 每个请求带 `Client-Form-Id`；`Client-App-Id: wxa4dd314619820d4c`，`ver: 3.80.0`，`Client-Env: h5`
- 关键接口：
  - `GET /v1/userInfo` 校验 token
  - `GET /v1/form/{fid}/profile`、`GET /v1/form/{fid}/catalog`
  - `GET /v3/{fid}/form_data` 我的提交记录
  - `POST /v1/{fid}/form_data` 提交，body 含 `formVersion` + `catalogs`（所有必填题一次带齐）
  - 登录：`GET /v1/{appid}/mpQrCode`、`GET /v1/mpQrLoginResult?scene=`
- 错误码：`13426` = 每人限 1 次（已签）；定位题是 `LOCATION`，值用 GeoJSON Point `[lng,lat]`。

## 课堂派 ketangpai
- API：`https://openapiv5.ketangpai.com`，POST JSON，头 `token: <token>`
- 成功 `{status:1,data}`；`code 20003` = token 过期
- 接口：`/courseApi/simpleLists`、`/AttenceApi/getNotFinishAttenceStudent`、`/SummaryApi/attence`、`/AttenceApi/getCheckInResult`、`/AttenceApi/checkin`
- 考勤类型：0 传统 / 1 数字 / 2 GPS / 3 扫码 / 4 签入签出
- 判定：`state ∈ {0,2,7}` 且 `signTime>0`；签入签出用 `resultCheckoutTime` 复核
- token 来源：登录 `w.ketangpai.com` 后 `localStorage.token` / `token_for_login`

## WPS 表单
- 围栏：`POST https://f-api.wps.cn/ksform/api/v3/campaign/{shareId}/ranges`，返回多边形顶点（GCJ-02，`coordType=gcj02`）
- 取围栏面积重心 → GCJ-02 反算 WGS84 → 注入 `navigator.geolocation`（页面按 WGS84 语义再转回 GCJ-02 比对）
- 登录态：`wps_sid` 等 Cookie；访问 `account.wps.cn` 用 kso 会话自动续期并回写
- 表单选择器：姓名 `#inputclockinName`、学号 `#inputclockinStudentId`、提交按钮 `.src-pages-clock-...__container`

## 定位坐标系
- WGS84：GPS、Google Maps、浏览器 `navigator.geolocation` 语义
- GCJ02：微信、高德、腾讯、绝大多数国内 App
- BD09：百度
- 互转用 `geo convert`；GCJ02↔WGS84 为迭代反算，误差 <1m。
