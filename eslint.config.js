import parser from '@babel/eslint-parser';
import jsx from '@babel/plugin-syntax-jsx';
import typescript from '@babel/preset-typescript';

/* oxlint carries the real lint rules; eslint is here only for max-len, which oxlint omits.
 * The babel parser stands in for typescript-eslint, which does not support TypeScript 7 yet, and
 * it sees no filename, so .tsx has to opt into JSX by hand. */
const babel = (plugins) => ({
  parser,
  parserOptions: {
    requireConfigFile: false,
    babelOptions: { presets: [[typescript, { ignoreExtensions: true }]], plugins },
  },
});

export default [
  { files: ['src/**/*.ts'], languageOptions: babel([]), rules: { 'max-len': ['error', { code: 120 }] } },
  { files: ['src/**/*.tsx'], languageOptions: babel([jsx]), rules: { 'max-len': ['error', { code: 120 }] } },
];
