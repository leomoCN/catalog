// 原子写 JSON 文件：先写同目录临时文件，再备份上一版到 <target>.bak，最后 rename 覆盖。
// 供 server.js（admin-store 持久化）与 build-catalog.mjs（目录落盘）复用。
// Windows 下目标文件可能被短暂占用（杀毒扫描等）导致 copy/rename 触发 EPERM/EBUSY，
// 因此对备份与最终 rename 做有限次短退避重试（与 server.js 图片写路径的 renameWithRetry 一致）。
import { copyFile, rename, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

async function retryableRename(from, to, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (error && (error.code === 'EPERM' || error.code === 'EBUSY') && i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        continue;
      }
      throw error;
    }
  }
}

export async function writeJsonAtomic(target, data) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await copyFile(target, `${target}.bak`);
      break;
    } catch (error) {
      if (error && (error.code === 'EPERM' || error.code === 'EBUSY') && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        continue;
      }
      break; // 首次写入，尚无上一版可备份
    }
  }
  await retryableRename(tmp, target);
}
