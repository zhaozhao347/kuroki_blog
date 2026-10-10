---
title: 页面标题（会渲染成面板里的大标题）
date: 2026-01-01
eyebrow: 页眉小字（如「关于」）
summary: 标题下面那段引言，一句话说清这一页是什么。
cover: assets/avatar.jpg
name: 卡片上的名字
tagline: 卡片上的签名 / 一句话
links:
  - label: 邮箱
    href: mailto:you@example.com
    icon: mail
---

<!--
  页面（pages）模板 —— 复制这个文件、改名成 `slug.md` 就能加一页。
  ★ 文件名就是 slug：`about.md` → 路由用它取数据（`findPage('about')`）。
    与文章/项目不同，页面**不带日期前缀**（它不是一个「某天发生的事」）。

  frontmatter 字段
  ─────────────────────────────────────────────────────────────
  title    必填   面板里的大标题
  date     必填   YYYY-MM-DD。页面本身不显示它（排序用），但引擎要求每篇内容都有
  eyebrow  可选   标题上方的小字（如「关于」）
  summary  可选   标题下方的引言
  cover    可选   卡片用的图 —— 在页面里它是**头像/主图**
                  （写 `assets/xxx.jpg` 用本目录的图，或写通用作品图池的文件名）
  name     可选   左侧粘性卡片上的名字
  tagline  可选   卡片上的签名
  links    可选   卡片底部那排图标按钮，每项 { label, href, icon }
                  icon 可选：github / steam / mail / link（不认识的会退回通用外链图标）
                  href 必须是 http(s)（构建期会拦 javascript: 之类的协议）

  正文就是普通 Markdown（h2 / 列表 / 代码块 / 引用都能用）。

  自检：`npm run check:pages`
-->
