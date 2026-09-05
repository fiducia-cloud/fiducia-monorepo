// ores-lint house config for the fiducia monorepo (13 JS packages, 22 crates).
import oresConfig from './.ores-lint/eslint/base.mjs';
import oresPlugin from './.ores-lint/eslint/plugin.mjs';

const base = await oresConfig({
  ignores: ['gitops/**', 'apps/**/dist/**', 'apps/**/.next/**', 'docs/**'],
});

export default [
  ...base,
  // A financial-services monorepo: silently swallowed async failures and
  // unhandled rejections are the expensive class of bug here, so the async
  // correctness rules are raised above the fleet baseline.
  {
    files: ['apps/**/*.{js,mjs,cjs}'],
    plugins: { ores: oresPlugin },
    rules: {
      'require-atomic-updates': 'warn',
      'no-return-await': 'warn',
      'no-await-in-loop': 'warn',
      'no-unsafe-finally': 'warn',
    },
  },
];
