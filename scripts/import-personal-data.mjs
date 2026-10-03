import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.mjs';
import { createStore } from '../server/storage.mjs';
import { validateResumeData } from '../web/shared/model.mjs';

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error('用法：node scripts/import-personal-data.mjs <jsonFile>');
  process.exitCode = 1;
} else {
  try {
    const input = JSON.parse(await readFile(resolve(args[0]), 'utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 2 || !Object.hasOwn(input, 'name') || !Object.hasOwn(input, 'data') ||
        typeof input.name !== 'string' || !input.name.trim() || input.name.length > 2000) {
      throw new Error('输入须为 {name:string,data:ResumeData}，名称须为 1–2000 字符。');
    }
    const validated = validateResumeData(input.data);
    if (!validated.ok) throw new Error('简历数据格式无效，请按 web/shared/model.mjs 的结构检查字段。');
    if (validated.value.logo.assetId !== null) throw new Error('此 JSON 入口不能导入图片引用，请改用网页的导入备份或导入后上传校徽。');
    const config = await loadConfig(fileURLToPath(new URL('../', import.meta.url)));
    const store = await createStore(config);
    const doc = await store.create({ name: input.name, language: validated.value.language, seed: validated.value });
    console.log(JSON.stringify({ name: doc.name, id: doc.id }));
  } catch (cause) {
    // Never echo filesystem paths, JSON source text, or private field values.
    const message = cause.code === 'ENOENT' ? '指定文件不存在。'
      : cause instanceof SyntaxError ? '文件不是有效 JSON。'
      : cause.constructor === Error && !cause.code ? cause.message
      : '请检查指定 JSON、本地配置与数据目录权限。';
    console.error(`导入失败：${message}`);
    process.exitCode = 1;
  }
}
