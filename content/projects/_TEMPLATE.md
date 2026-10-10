---
title: 项目名
date: 2026-01-01
summary: 一句话摘要 —— 会出现在项目卡片上。
# cover: 封面图.avif        # 可选：放 content/projects/assets/，或写通用作品图池里的文件名
---

正文从这里开始，用 Markdown 写 —— 和文章一样。

## 做了什么

段落文字。

- 列表项
- 列表项

> 引用。

## 字段速查（复制模板后请删掉这一节）

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | ✅ | 项目名（卡片与详情页的**大标题**） |
| `date` | ✅ | `YYYY-MM-DD`，**必须补零**（`2026-1-1` 会被拒绝）；列表按它倒序，页面上只显示派生出的**年份** |
| `summary` | ✅ | 一句话摘要（卡片与详情页的**小标题**） |
| `cover` | ⬜ | 封面图（卡片上的**图片**）：放 `content/projects/assets/`，或直接写 `src/assets/works/` 里的文件名 |

★ 项目**没有** `category` / `tags` / `role` / `link` —— 卡片上只有
「图片 / 年份 / 大标题 / 小标题」四样。写 `tags:` 会被构建期明确拒绝
（不显示也不报错才是最糟的：你会以为它生效了）。

文件名决定 URL：`2026-09-28-my-thing.md` → `/projects/my-thing`
（slug = 文件名去掉 `YYYY-MM-DD-` 前缀）。

正文配图：把图放进 `content/projects/assets/`，再按行内图片语法引用
（**不支持**引用式图片语法）。

自检：`npm run check:projects`（只查项目）／`npm run check`（查内容 + 类型 + 构建）。
