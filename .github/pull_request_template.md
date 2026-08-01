## Summary

<!-- Briefly describe what this PR does and why. Link related issues with "Closes #N" or "Fixes #N". -->



## Type of Change

- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)
- [ ] ✨ New feature (non-breaking change that adds functionality)
- [ ] 💥 Breaking change (fix or feature that would cause existing functionality to change)
- [ ] ♻️ Refactor (code change that neither fixes a bug nor adds a feature)
- [ ] 📝 Documentation (changes to docs only)
- [ ] 🧪 Tests (adding or updating tests)
- [ ] 🔧 Chore (tooling, CI, dependencies)

## Component

- [ ] Backend — `auth`
- [ ] Backend — `cloud`
- [ ] Backend — `cmdb`
- [ ] Backend — `expense`
- [ ] Backend — `recommendation`
- [ ] Backend — `alert` / `webhook`
- [ ] Backend — `tagging` / `rules` / `constraints`
- [ ] Backend — `power_schedule` / `scheduler`
- [ ] Frontend — Pages
- [ ] Frontend — Components / Layout
- [ ] Database / Migrations
- [ ] Docker / CI / Deployment
- [ ] E2E Tests
- [ ] Documentation

## Changes

<!-- Describe your changes in detail. Include:
  - New endpoints or routes
  - Database migration files
  - New frontend pages or components
  - Any configuration changes
-->

## Checklist

Before requesting review, please ensure:

- [ ] My code follows the project's [coding standards](../CONTRIBUTING.md#coding-standards)
- [ ] I have run `make fmt` (no formatting diffs)
- [ ] I have run `make lint` (no new warnings)
- [ ] I have run `make test` (all tests pass)
- [ ] New/changed API handlers have `#[utoipa::path]` annotations
- [ ] Database changes have a numbered migration file
- [ ] Frontend builds cleanly (`npm run build` — 0 TypeScript errors)
- [ ] No `unwrap()`, `expect()`, or `panic!()` in production paths
- [ ] I have added tests that prove my fix/feature works
- [ ] My commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)

## Screenshots / Recordings

<!-- If this PR includes UI changes, add before/after screenshots or a short recording. -->

## Additional Notes

<!-- Any additional context, decisions, or open questions for reviewers. -->
