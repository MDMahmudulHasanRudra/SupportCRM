import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  { ignores: ['dist/**', 'node_modules/**', '*.config.js', '*.config.mjs'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      // `_`-prefixed names are intentional discards — an unused destructured sibling, an unused
      // handler argument, a caught-but-ignored error.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      /**
       * The architectural boundary from docs/adr/0001 §7, enforced by the linter rather than by
       * review alone: only `modules/channel/whatsapp/**` may import an OpenWA client. Everything
       * else must go through the ChannelAdapter interface.
       *
       * The rule exists now, before the adapter does, so the first import that would violate it
       * fails CI on the day it is written — not months later when it is load-bearing.
       */
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/gateway/**', '@open-wa/*', 'whatsapp-web.js', '@whiskeysockets/baileys'],
              message:
                'Only modules/channel/whatsapp may talk to the WhatsApp gateway. ' +
                'Business logic must use the ChannelAdapter interface (PROJECT_SPEC.md §54).',
            },
            {
              // The first version of this rule only blocked the gateway PACKAGE, which let a
              // business module import the adapter's own OpenWA types instead — the same coupling
              // by a shorter route. Blocking the directory closes it.
              group: ['**/channel/whatsapp/**', '**/whatsapp/openwa*'],
              message:
                'Provider-specific types and mappers are internal to modules/channel/whatsapp. ' +
                'Use the neutral ChannelAdapter interface and ChannelRegistryService instead ' +
                '(docs/adr/0001 §7).',
            },
          ],
        },
      ],
    },
  },
  {
    /**
     * The Knowledge Base is channel agnostic and must stay that way (Phase 4).
     *
     * It deals in opaque group and customer UUIDs for scope filtering, and has no business knowing
     * that a message arrived over WhatsApp — or that a channel layer exists at all. This is the
     * rule that keeps "add a second channel without rewriting core business logic"
     * (PROJECT_SPEC.md §206.45) true rather than aspirational.
     */
    files: ['src/modules/knowledge/**/*.ts', 'src/modules/automation/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/channel/**', '**/messaging/**', '**/ingestion/**', '**/gateway/**', '@open-wa/*'],
              message:
                'The knowledge module must stay channel agnostic. It takes group and customer ids ' +
                'as opaque UUIDs and must not import a channel, an adapter or a messaging type.',
            },
          ],
        },
      ],
    },
  },
  {
    /**
     * The Decision Engine is channel agnostic (Phase 5).
     *
     * It reasons about conversations, messages and identities. It must never learn that a message
     * arrived over WhatsApp — that is what keeps "add a second channel without rewriting core
     * business logic" (PROJECT_SPEC.md §206.45) true. It DOES use the messaging module, because
     * that owns the single outbound control point; what it must not touch is the channel layer
     * underneath it.
     */
    files: [
      'src/modules/decision/**/*.ts',
      'src/modules/escalation/**/*.ts',
      // The AI layer joins the same boundary in Phase 6: it is asked a question and returns a
      // verdict, and must not be able to reach a channel adapter even by accident. It also has no
      // business importing MessageService — the AI decides nothing about sending.
      'src/modules/ai/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/channel/**', '**/gateway/**', '@open-wa/*', 'whatsapp-web.js'],
              message:
                'The Decision Engine must stay channel agnostic. Send through MessageService; ' +
                'never reach for a channel adapter or a gateway type.',
            },
          ],
        },
      ],
    },
  },
  {
    // The adapter itself, and the channel module that registers it, are the two places the
    // boundary does not apply — a module must be able to provide its own implementation.
    files: ['src/modules/channel/whatsapp/**/*.ts', 'src/modules/channel/channel.module.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // Tests may reach into internals and use `any` when constructing awkward fixtures.
    files: ['test/**/*.ts', 'src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      // Tests legitimately reach into adapter internals — asserting that normalization and
      // sanitisation are correct is exactly what they are for. The boundary protects production
      // code from coupling, not tests from inspecting it.
      'no-restricted-imports': 'off',
    },
  },
];
