---
title: 文章标题
date: 2026-01-01
category: 随笔
tags: [标签一, 标签二]
summary: 一句话摘要 —— 会出现在列表页卡片与归档页。
# cover: 封面图.png        # 可选：图片放 content/posts/assets/，这里写文件名
---

正文从这里开始，用 Markdown 写。

## 小标题

段落文字。

- 列表项
- 列表项

> 引用。

## 字段速查（复制模板后请删掉这一节）

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | ✅ | 文章标题 |
| `date` | ✅ | `YYYY-MM-DD`，**必须补零**（`2026-9-1` 会被拒绝） |
| `category` | ✅ | 主分类，单值；写个新的就会自动出现在列表页第一排筛选里 |
| `tags` | ⬜ | 多标签数组，≤8 个、每个 ≤24 字，例：`tags: [前端, CSS]` |
| `summary` | ✅ | 摘要，列表页卡片用 |
| `cover` | ⬜ | 封面图文件名（图片放 `content/posts/assets/`） |

正文配图：把图片放进 `content/posts/assets/`，再按行内图片语法引用
（写法见已有文章，或 `AGENTS.md` §8；**不支持**引用式图片语法）。

自检：`npm run check:posts`（只查文章）／`npm run check`（查文章 + 类型 + 构建）。
