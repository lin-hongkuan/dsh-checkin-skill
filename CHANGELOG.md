# Changelog

## 1.2.0

- 新增 **小小签到 (xiaoqiandao)** 适配：微信扫码登录（`/xcx/checkin_web/v1/qrcode|check_status`）、
  列表/详情（`/xcx/checkin/v3/list`、`/v5/detail[_noauth]`）、提交（`/xcx/checkin/v3/doit`，
  含 `fill_params:[{key:6,val,lat,lon}]` 地理位置字段）、复核。
- 正确处理：电子围栏(locations) 需小程序、地理位置字段可 H5 提交、口令/扫码/WiFi/班级作业类给出 `NEED_*` 提示。
- 新增 `doctor` 的 xiaoqiandao 网络/登录态检查。

## 1.1.0

- 以 **DSH Skill** 形式发布（`checkin/SKILL.md` + 零依赖 Node CLI）。
- 平台：群报数(qun100) / 课堂派(ketangpai) / WPS 表单 / 通用网页表单 / 微信小程序接口回放。
- 能力：自动取 token（浏览器登录 / 二维码）、自动定位（接口 / 围栏优先 + GCJ-02 纠偏）、
  CDP 虚拟定位、网络抓包、结果截图与回执。
- 新增 `doctor` 自检与 `--version`。
- 登录与浏览器操作按"一条命令内完成"设计（适配单次命令隔离的运行环境）。
