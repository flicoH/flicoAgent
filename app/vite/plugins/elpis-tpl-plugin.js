const fs = require('fs');
const path = require('path');

const toEntryModulePath = entryPath => {
  const relativePath = path.relative(process.cwd(), entryPath);
  const normalizedRelativePath = relativePath.split(path.sep).join('/');

  if (relativePath.startsWith('..')) {
    const absolutePath = path.resolve(entryPath).split(path.sep).join('/');
    return `/@fs${absolutePath.startsWith('/') ? '' : '/'}${absolutePath}`;
  }

  return `/${normalizedRelativePath}`;
};

module.exports = () => ({
  name: 'elpis-tpl-plugin',
  configureServer(server) {
    void server;
    const { allEntries } = require('../config/vite.base');
    const templatePath = path.resolve(__dirname, '../../view/entry.tpl');
    const outputDir = path.resolve(process.cwd(), './app/public/dist');
    const template = fs.readFileSync(templatePath, 'utf8');
    const DEV = 'http://127.0.0.1:9002';

    fs.mkdirSync(outputDir, { recursive: true });
    Object.entries(allEntries).forEach(([entryName, entryPath]) => {
      const entryModulePath = toEntryModulePath(entryPath);
      const scripts = [
        `<script type="module" src="${DEV}/@vite/client"></script>`,
        `<script type="module" src="${DEV}${entryModulePath}"></script>`,
      ].join('\n  ');
      const content = template.replace('</body>', `  ${scripts}\n  </body>`);
      const outputPath = path.resolve(outputDir, `${entryName}.tpl`);

      fs.writeFileSync(outputPath, content);
    });

    return;
  },
  generateBundle(options, bundle) {
    void options;
    const { allEntries } = require('../config/vite.base');
    const templatePath = path.resolve(__dirname, '../../view/entry.tpl');
    const outputDir = path.resolve(process.cwd(), './app/public/dist');
    const template = fs.readFileSync(templatePath, 'utf8');
    const outputs = Object.values(bundle);

    fs.mkdirSync(outputDir, { recursive: true });
    Object.entries(allEntries).forEach(([entryName, entryPath]) => {
      const entryChunk = outputs.find(output => {
        if (output.type !== 'chunk' || !output.isEntry) return false;
        if (output.name === entryName) return true;
        if (!output.facadeModuleId) return false;

        return path.resolve(output.facadeModuleId) === path.resolve(entryPath);
      });

      if (!entryChunk) {
        throw new Error(`[elpis-tpl-plugin] entry chunk not found: ${entryName}`);
      }

      const cssFiles = new Set();
      const visitedChunks = new Set();
      const collectCss = chunk => {
        if (!chunk || chunk.type !== 'chunk' || visitedChunks.has(chunk.fileName)) return;
        visitedChunks.add(chunk.fileName);

        const importedCss = chunk.viteMetadata && chunk.viteMetadata.importedCss;
        if (importedCss) {
          importedCss.forEach(fileName => cssFiles.add(fileName));
        }
        chunk.imports.forEach(fileName => collectCss(bundle[fileName]));
      };

      collectCss(entryChunk);
      if (cssFiles.size === 0) {
        outputs
          .filter(output => output.type === 'asset' && output.fileName.endsWith('.css'))
          .forEach(output => cssFiles.add(output.fileName));
      }

      const styles = [...cssFiles]
        .map(fileName => `<link rel="stylesheet" href="/dist/prod/${fileName}">`)
        .join('\n  ');
      const script = `<script type="module" src="/dist/prod/${entryChunk.fileName}" crossorigin></script>`;
      const withStyles = styles
        ? template.replace('</head>', `  ${styles}\n  </head>`)
        : template;
      const content = withStyles.replace('</body>', `  ${script}\n  </body>`);
      const outputPath = path.resolve(outputDir, `${entryName}.tpl`);

      fs.writeFileSync(outputPath, content);
    });

    return;
  },
});
