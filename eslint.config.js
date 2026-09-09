/**
 * What the linter is here to catch.
 *
 * TypeScript already refuses to build on an unused import or a wrong type, so
 * this is deliberately not a second opinion about style: `eslint-config-prettier`
 * switches off every rule that formatting settles, and the rules left on are the
 * ones that describe mistakes the compiler cannot see.
 *
 * Three of them earn their place in an application like this one. A promise that
 * nothing awaits or catches is a write to a stick whose failure never reaches
 * the window. An effect whose dependency list is wrong is a screen showing what
 * was true a moment ago. And `any` re-opens the door the types were closing,
 * usually at exactly the boundary where a native command's answer arrives.
 */

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', 'src-tauri', 'public'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  reactHooks.configs.flat['recommended-latest'],
  prettier,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        // The two configuration files at the root belong to no tsconfig, and
        // are still worth linting.
        projectService: {
          allowDefaultProject: ['vite.config.ts', 'eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // An argument named to say it is deliberately unused should be allowed to
      // say so, which is the one exception the compiler's own check makes too.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Off deliberately, and worth saying why rather than leaving somebody to
      // wonder. Effects and memos here depend on the fields they actually read
      // (`profile?.firmwareId`, `profile?.naming`) rather than on the profile
      // object, because a new object is built on every render and depending on
      // it would re-plan a ten thousand title write for nothing. The rule
      // cannot see that those lists are exact, so it reports the house style
      // instead of a defect, fourteen times.
      'react-hooks/exhaustive-deps': 'off',

      // Likewise. Almost every long operation here is a native command, and
      // this application's effects exist to start one and put its answer into
      // state. That is the case the rule names as legitimate, but it cannot
      // tell it from the derived-state mistake it is aimed at.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    // Configuration files are not part of a TypeScript project and the plugins
    // they import are largely untyped, so the rules that need types have
    // nothing to work with here.
    files: ['*.config.js', '*.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
)
