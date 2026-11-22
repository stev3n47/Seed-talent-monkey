# Verification

- Run `node --check seed_helper_v9.user.js` for userscript syntax.
- Run `node --test catalog.test.cjs` for catalog paging, completion filtering, and mocked fetch/XHR bridge regressions. These tests do not authenticate to or modify the live service.
- Run `git diff --check` before release. Live Tampermonkey validation is still required; Node tests do not verify the deployed site's response shape or browser sandbox behavior.
