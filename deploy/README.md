# 宏图战术 · 在线产品画册（GitHub Pages 部署包）

本目录是可直接部署到 GitHub Pages 的完整站点包：

| 文件 | 说明 |
|---|---|
| `index.html` | 画册页面（含编辑密码锁，密码哈希内置于代码） |
| `media-output/` | 12 张产品图（页面引用目录，必须一起上传） |
| `.nojekyll` | 防止 GitHub Pages 忽略下划线目录，必须保留 |

---

## 一、上线步骤（网页上传方式，无需命令行）

1. 打开 https://github.com/new 新建仓库（Public 或 Private 均可）：
   - Repository name 建议填 `catalog`（或其他英文名）
   - 不要勾选 "Add a README file"（保持空仓库）
   - 点 **Create repository**
2. 在新仓库页面点 **uploading an existing file**（或「上传文件」按钮）
3. 把本目录内的 **index.html、.nojekyll、media-output 文件夹（整个）** 拖进上传区，点 **Commit changes**
4. 进入仓库 **Settings → Pages**：
   - Source 选 **Deploy from a branch**
   - Branch 选 **main**，目录选 **/(root)**，点 Save
5. 等 1-2 分钟，访问地址：

```
https://leomoCN.github.io/catalog/
```

> 若仓库名不是 `catalog`，把地址中的 `catalog` 换成你的仓库名。
> Private 仓库的 Pages 链接只有登录了你 GitHub 账号的人能看；要公开给同事，请用 Public 仓库或把同事加为协作者。

---

## 二、同事访问与编辑权限

- **任何人**打开页面都能浏览全部产品、点开详情、切换多图与 SKU。
- 点击右上角「编辑模式」会要求输入**编辑密码**，只有你一个人知道，输错无法进入编辑。
- 编辑密码当前为：`leo6849032`（初始值，可修改，见下节）。

---

## 三、修改编辑密码

1. 用任意在线 SHA-256 工具（搜索 "sha256 hash"）计算新密码的哈希值。
2. 打开 `index.html`，搜索 `EDIT_PASS_HASH`，把单引号内的哈希替换为新值并保存。
3. 重新上传推送 `index.html` 即生效。

---

## 四、更新画册内容（重要）

页面数据保存在**浏览器本地**。同事看到的是**烘焙进页面里的默认数据**，因此更新流程为：

1. 打开线上页面 → 输入密码进入编辑模式 → 修改产品/文字/图片。
2. 点编辑栏「**导出数据**」，浏览器会下载 `catalog-data.json`。
3. 把该文件内容发给维护者（如 AI 助手），由维护者将数据烘焙进 `index.html` 的 `DEFAULT_DATA`。
4. 重新上传 `index.html` 推送，同事刷新即可看到新内容。

（也可以点「导入数据」把备份 JSON 恢复到当前浏览器，用于本地还原。）

---

## 五、后续推送方式（可选：git 命令行）

在装有 Git 的电脑上：

```bash
git init
git add .
git commit -m "init catalog"
git branch -M main
git remote add origin https://github.com/leomoCN/catalog.git
git push -u origin main
```

> 推送时需要 GitHub 账号凭据；若首次使用，按提示登录即可。
