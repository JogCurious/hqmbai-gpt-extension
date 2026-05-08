# 好奇漫步GPT网页实时备份器 v2.6

这是一个仅本地加载的 Chromium 扩展，给 ChatGPT 聊天页面提供：

- 原生 Blink `MHTML` 实时保存
- 当前网页与当前 Markdown 同步保存
- 历史网页与历史 Markdown 归档
- 右下角实时备份面板
- 顶部临时聊天状态提醒
- 非临时聊天输入与发送时的隐私提醒
- 工具栏弹窗设置与自定义目录绑定

## 联系方式

- QQ：`3789299667`
- 更新页：[飞书页面](https://dcnhigwbreiu.feishu.cn/wiki/VdXfwnaCViCYumkNb7oc4ZbxnKd)
- GitHub：[https://github.com/JogCurious/hqmbai-gpt-extension](https://github.com/JogCurious/hqmbai-gpt-extension)

## 保存目录

第一次使用时，请在扩展弹窗里点击“选择保存目录”。

目录结构固定为：

- `当前网页/`
- `历史网页/`
- `当前Markdown/`
- `历史Markdown/`
- `导出/`

扩展会记住你选择的目录；如果浏览器回收了目录授权，需要重新选择一次。

## 已集成功能

- 原生 MHTML 自动保存
- 手动保存网页 / 归档网页
- Markdown 自动同步
- 导出 Markdown / JSON
- 手动切分
- 同时重命名当前网页与当前 MD
- 顶部提醒开关
- 非临时聊天隐私提醒开关
- 记住提醒框位置开关

## 安装方法

1. 打开 Chrome 或 Edge
2. 进入扩展页
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
3. 打开右上角“开发者模式”
4. 点击“加载已解压的扩展程序”
5. 选择当前这个扩展目录
6. 打开 ChatGPT 聊天页
7. 在扩展弹窗里先选择保存目录，再开启自动保存

## 已知说明

- 依赖 Chromium 的 `pageCapture`，目标浏览器是 Chrome / Edge
- 关闭标签页瞬间无法保证 100% 成功补存，但因为平时会持续自动落盘，风险会低很多
