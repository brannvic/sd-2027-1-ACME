import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [tailwindcss(), {
    name: 'version-de-la-pwa',
    apply: 'build',
    async writeBundle({ dir }) {
      if (!dir) return;
      const version = createHash('sha256').update(await readFile(resolve(dir, 'index.html'))).digest('hex').slice(0, 12);
      const ruta = resolve(dir, 'sw.js');
      await writeFile(ruta, (await readFile(ruta, 'utf8')).replace("'v1'", JSON.stringify(version)));
    },
  }],
});
