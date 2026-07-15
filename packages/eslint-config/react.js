module.exports = {
  ...require('./index.js'),
  env: { browser: true, es2022: true },
  extends: [
    ...require('./index.js').extends,
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  settings: { react: { version: 'detect' } },
  rules: {
    ...require('./index.js').rules,
    'react/prop-types': 'off',
  },
};
