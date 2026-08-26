import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * The console's lint rules.
 *
 * The rule that matters most here is the last one: nothing in this application may name the
 * WhatsApp gateway. Its URL, its API key and its session UUIDs are server-side infrastructure, and
 * anything a bundler can see is public (`docs/WHATSAPP_UX_ARCHITECTURE.md` §9). The API's own
 * ESLint boundary enforces the other half — that only the adapter directory may import it.
 */
export default tseslint.config(
  { ignores: ['dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Literal[value=/openwa|OpenWA|x-api-key|X-API-Key|localhost:2785/]",
          message:
            'The WhatsApp gateway must never be named in frontend code. The browser talks only to ' +
            'the Support CRM API; the gateway is internal infrastructure.',
        },
        {
          selector: "MemberExpression[object.name='localStorage']",
          message:
            'Session state belongs in the API httpOnly cookie, which JavaScript cannot read. ' +
            'Anything in localStorage is readable by an XSS payload.',
        },
      ],
    },
  },
);
