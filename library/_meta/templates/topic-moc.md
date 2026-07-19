---
title: <% tp.file.title %>
type: moc
tags: []
aliases: []
up: "[[Library Index]]"
related: []
created: <% tp.date.now("YYYY-MM-DD") %>
updated: <% tp.date.now("YYYY-MM-DD") %>
---

# <% tp.file.title %>

> [!abstract] Map of content
> Overview of this topic and the pages beneath it.

## Wiki pages

```dataview
TABLE confidence, updated
FROM "library/wiki"
WHERE up = this.file.link
SORT updated DESC
```

## Raw notes

```dataview
TABLE source, accessed
FROM "library/raw"
WHERE up = this.file.link
SORT file.name ASC
```
