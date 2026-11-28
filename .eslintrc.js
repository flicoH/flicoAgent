module.exports = {
  root: true,
  env: {
    browser: true,
    es2020: true,
    node: true,
    mocha: true,
  },
  extends: [
    'plugin:vue/vue3-essential',
  ],
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  rules: {
    'no-console': 'off',
    'no-debugger': 'warn',
    'vue/multi-word-component-names': 'off',
    'vue/valid-v-for': 'warn',
  },
};
