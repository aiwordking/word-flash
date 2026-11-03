# 部署指南

`word-flash` 是纯静态站点：没有后端、没有构建步骤，部署的本质就是把文件夹放到一个能被浏览器访问的地址。

## 方案 A：局域网访问（最快）

当前机器已经可以用：

```text
http://10.236.135.162:5173
```

同一 Wi-Fi / 办公网内的手机或电脑可以直接试这个地址。

如果打不开，通常是 Windows 防火墙拦截了 Python。用管理员 PowerShell 放行端口：

```powershell
New-NetFirewallRule -DisplayName "FlashVocab 5173" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Domain,Private
```

启动命令（在 `word-flash` 目录）：

```bash
python -m http.server 5173 --bind 0.0.0.0
```

注意：

- 公司网络可能开启客户端隔离，设备之间互相访问会被禁止；此时改用下面的公网方案。
- 电脑休眠、切换网络或关闭终端后地址会失效。
- 这个地址是 HTTP，不是 HTTPS；仅适合内网临时使用。

## 方案 B：Netlify Drop（最推荐，零命令行）

1. 打开 <https://app.netlify.com/drop>。
2. 把整个 `word-flash` 文件夹（或 `word-flash.zip`）拖进去。
3. 几秒后会得到一个 `https://xxx.netlify.app` 地址，直接发给别人即可。
4. 登录后可改站点名、绑定自己的域名。

优点：免费、自动 HTTPS、全球 CDN、无需安装任何工具。

## 方案 C：Cloudflare Pages

```bash
cd word-flash
npx wrangler pages deploy . --project-name flashvocab
```

首次运行会要求登录 Cloudflare。部署完成后得到 `https://flashvocab.pages.dev`，可在控制台绑定自定义域名。

## 方案 D：Vercel

```bash
cd word-flash
npx vercel --prod
```

框架选择 **Other**，Build Command 留空，Output Directory 保持 `.`。完成后得到 `https://xxx.vercel.app`。

## 方案 E：GitHub Pages

1. 新建仓库，把 `word-flash` 里的文件推到仓库根目录。
2. 仓库 Settings → Pages → Source 选择 `Deploy from a branch`。
3. Branch 选 `main`，目录选 `/ (root)`，保存。
4. 一分钟后访问 `https://<用户名>.github.io/<仓库名>/`。

所有资源都使用相对路径，放在子目录下也能正常工作。

## 方案 F：国内云对象存储

适合国内访问速度要求高的场景：

1. 阿里云 OSS / 腾讯云 COS / 七牛云创建 bucket。
2. 开启静态网站托管，默认首页设为 `index.html`。
3. 上传 `word-flash` 内的全部文件（保持 `assets/`、`data/` 目录结构）。
4. 绑定自定义域名并开启 HTTPS/CDN。

注意：对象存储的默认测试域名可能会强制下载而不是直接打开网页，绑定域名后正常。

## 方案 G：自己的服务器 / NAS（Docker）

项目自带 `Dockerfile` 和 `nginx.conf`：

```bash
cd word-flash
docker build -t flashvocab .
docker run -d --name flashvocab -p 8080:80 --restart unless-stopped flashvocab
```

访问 `http://服务器IP:8080`。

不用 Docker 也可以直接把文件放进 Nginx 的站点根目录，参考 `nginx.conf` 的缓存配置。

## 自定义域名与 HTTPS

- Netlify / Vercel / Cloudflare Pages：控制台 → Domains，按提示添加 DNS 记录，HTTPS 自动签发。
- 自己的服务器：用 Caddy 最简单：

```caddyfile
flash.yourdomain.com {
    root * /var/www/word-flash
    file_server
}
```

Caddy 会自动申请 Let's Encrypt 证书。

## 部署后要注意

学习进度保存在浏览器的 `localStorage`，按「协议 + 域名 + 端口」隔离：

- 从 `localhost:5173` 换到 `https://xxx.netlify.app`，进度不会自动带过去。
- 迁移前在 App 的「设置 → 数据备份 → 导出」保存 JSON，在新地址用「导入」恢复。
- 清理浏览器站点数据会丢失进度，重要数据请定期导出。

如果启用了可选的云同步，静态部署方式不变；另外需要一个 Supabase 免费项目，配置步骤见 [CLOUD.md](CLOUD.md)。

## 选择建议

- 只想发给别人用：**Netlify Drop**。
- 国内用户为主：**对象存储 + CDN** 或自己的服务器。
- 团队内网使用：**局域网方案**，或部署到公司内部 Nginx。
- 需要版本管理：**GitHub Pages**。
