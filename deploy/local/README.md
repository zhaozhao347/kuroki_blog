# 内网版：把这套博客搬到局域网里

`local` 分支 = `main` + 这一坨东西。线上那套（GitHub Pages + Cloudflare + Worker）不受影响。

目标：一台内网机器上跑 nginx，**任何人连到这个路由器的 Wi-Fi / AP 都能打开**，
不依赖任何外网服务（Google Fonts、Cloudflare、网易云镜像全不碰）。

---

## 一、它和线上版的区别

| | 线上（main） | 内网（local） |
| --- | --- | --- |
| 构建 | `npm run build`，`BASE_PATH=/` | `node deploy/local/build.mjs`（`BASE_PATH=/` + `VITE_OFFLINE=1`） |
| 托管 | GitHub Pages + Cloudflare | 本机 nginx，`try_files` 兜 SPA 路由 |
| 浏览量 | Worker + KV | 不发请求，显示 `—` |
| 最近在玩 | Worker + Steam key | 卡片整块不渲染 |
| 音乐 | 网易云公共镜像 | 默认**没有歌**；放本地 mp3 才播（见第五节） |
| 字体/图片 | 全在仓库里 | 一样（本来就打包进来了） |

`VITE_OFFLINE=1` 是给这种场景加的开关，代码在 `src/playlist.ts`、
`src/composables/siteViews.ts`、`src/composables/steam.ts`、`src/env.d.ts`。

---

## 二、一次性装环境（Ubuntu / Debian）

```bash
sudo apt update && sudo apt install -y nginx rsync
sudo systemctl enable --now nginx
```

把站点配置放进去：

```bash
sudo cp deploy/local/nginx.conf /etc/nginx/sites-available/kuroki
sudo ln -sf /etc/nginx/sites-available/kuroki /etc/nginx/sites-enabled/kuroki
sudo rm -f /etc/nginx/sites-enabled/default       # 避免 default_server 抢端口
sudo nginx -t && sudo systemctl reload nginx
```

---

## 三、构建并发布

```bash
git checkout local && git pull
node deploy/local/build.mjs       # 产物在 dist/
bash deploy/local/install.sh      # 拷到 /var/www/kuroki 并 reload nginx
```

装完后用浏览器打开 `http://<这台机器的内网IP>/` 验证。

以后更新就重复这两行（`install.sh` 用 `rsync --delete`，旧的哈希文件不会越堆越多）。

---

## 四、让局域网里所有人都能访问

1. **给这台机器固定 IP**（路由器后台 → DHCP 静态分配，或在系统里配静态地址）。
   否则重启后 IP 变了，别人的书签就失效了。
2. **放行 80 端口**：
   ```bash
   sudo ufw allow 80/tcp        # 只在开了 ufw 的机器上需要
   ```
3. **确认它在路由器同一网段**（比如路由器 `192.168.1.1`，机器 `192.168.1.50`）。
   连 Wi-Fi / AP 的设备天然同网段，不需要额外配置。
4. **路由器不要开「AP 隔离 / 客户端隔离」** —— 开了以后设备之间互相 ping 不通，
   网站自然也打不开。这个开关一般在家用路由的「无线设置 → 高级」里。
5. 手机验证：连上 Wi-Fi，浏览器打开 `http://192.168.1.50/`。

### 想要一个好记的名字（可选）

内网没有 DNS，可以：

- 在路由器后台加一条**本地 DNS 记录**（有的固件叫「静态 DNS」「Hosts」）：
  `blog.lan → 192.168.1.50`；或
- 在每台设备上改 hosts（手机比较麻烦，不推荐）。

---

## 五、想放音乐（可选）

内网的机器连不上网易云，所以默认是没有歌的。想有歌：

```bash
sudo mkdir -p /var/www/kuroki/music
sudo cp 你的歌.mp3 /var/www/kuroki/music/
sudo chown -R www-data:www-data /var/www/kuroki/music
```

文件名要和 `src/playlist.ts` 里那首歌的 `slug` 对上，例如
`world-goes-round.mp3`、`anime-openings-be-like.mp3`。

然后**带音频目录构建**：

```bash
VITE_MUSIC_BASE=/music/ node deploy/local/build.mjs
bash deploy/local/install.sh
```

> `install.sh` 用 `rsync --delete` 只同步 `dist/`，`/var/www/kuroki/music/`
> 在 dist 之外，不会被删。

---

## 六、这个分支怎么保持更新

`.github/workflows/sync-local.yml`（在 `main` 上）会在**每次 push main 时**，
把 `main` 合并进 `local` 并推回远端。

- 所以平时只改 `main`，`local` 会自动跟上。
- 如果哪天 `main` 也改到了 `deploy/local/` 里的同名文件，合并可能冲突：
  那次 Actions 会红，本地解决后 `git push origin local` 即可。
- 也可以手动触发：Actions → **Sync local branch** → Run workflow。

拉最新内网版：

```bash
git checkout local && git pull && node deploy/local/build.mjs && bash deploy/local/install.sh
```

---

## 七、常见问题

**打开是 404 / 目录列表**：`root` 路径写错，或 `dist/` 没拷过去。
检查 `ls /var/www/kuroki/index.html`。

**刷新 `/about` 变 404**：nginx 少了 `try_files $uri $uri/ /index.html`（第二节那份配置里有）。

**手机上一直转圈 / 白屏**：先看是不是 AP 隔离（第四节第 4 点），
再用 `curl -I http://192.168.1.50/` 从另一台机器确认服务在。

**样式或字体不对**：确认是用 `node deploy/local/build.mjs` 构建的
（`BASE_PATH=/`）。用线上那份带 `/kuroki_blog/` 前缀的 dist 会全部 404。
