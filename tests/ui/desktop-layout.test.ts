import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

/** 读取项目根目录中的文本文件。 */
async function readProjectFile(relativePath: string): Promise<string> {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

describe('Windows PC 客户端布局', () => {
  it('不再包含窄屏或移动端媒体断点', async () => {
    const css = await readProjectFile('src/ui/styles.css');

    expect(css).not.toMatch(/@media\s*\(\s*max-width/i);
  });

  it('锁定应用根视口，只允许内容区域内部滚动', async () => {
    const css = await readProjectFile('src/ui/styles.css');
    const desktopStart = css.indexOf('/* Windows PC 客户端布局');

    expect(desktopStart).toBeGreaterThan(-1);

    const desktopCss = css.slice(desktopStart);
    expect(desktopCss).toMatch(/html,\s*body,\s*#app\s*\{[\s\S]*?overflow:\s*hidden;/);
    expect(desktopCss).toMatch(/\.skill-table-wrap\s*\{[\s\S]*?overflow:\s*auto;/);
  });

  it('Skill 使用带表头的语义化表格且操作不再使用二级菜单', async () => {
    const [app, css] = await Promise.all([
      readProjectFile('src/ui/app.tsx'),
      readProjectFile('src/ui/styles.css'),
    ]);
    const desktopCss = css.slice(css.indexOf('/* Windows PC 客户端布局'));

    expect(app).toContain('<table className="skill-table">');
    expect(app).toContain('<thead>');
    expect(app).toContain('<th scope="col">名称</th>');
    expect(app).toContain('<th scope="col">备注</th>');
    expect(desktopCss).toMatch(/\.skill-table\s*\{[^}]*table-layout:\s*fixed;/);
    expect(app).not.toContain('more-menu');
    expect(app).toContain('检查');
    expect(app).toContain('卸载');
  });

  it('Skill 管理页直接提供手动重启应用按钮', async () => {
    const app = await readProjectFile('src/ui/app.tsx');

    expect(app).toContain("['installed', 'apps', 'Skill 管理']");
    expect(app).toContain('<h1>Skill 管理</h1>');
    expect(app).toContain('重启应用');
    expect(app).toContain("backend.call('restartApplications.restartRunning')");
  });
  it('主操作与危险操作始终具备可辨识的实色背景', async () => {
    const css = await readProjectFile('src/ui/styles.css');
    const desktopCss = css.slice(css.indexOf('/* Windows PC 客户端布局'));

    expect(desktopCss).toMatch(/\.button--primary\s*\{[^}]*background:\s*var\(--accent\);/);
    expect(desktopCss).toMatch(/\.button--danger\s*\{[^}]*background:\s*var\(--danger\);/);
  });

  it('禁止窗口缩小到桌面工具无法正常操作的宽度', async () => {
    const config = JSON.parse(await readProjectFile('neutralino.config.json')) as {
      modes: { window: { minWidth: number } };
    };

    expect(config.modes.window.minWidth).toBeGreaterThanOrEqual(960);
  });
});
