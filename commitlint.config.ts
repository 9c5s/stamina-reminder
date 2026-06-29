export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'subject-case': [0],
    'scope-empty': [2, 'always'],
  },
};
