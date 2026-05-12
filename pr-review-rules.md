# PR Review Rules

## Code Quality
- Functions should have a single responsibility (Single Responsibility Principle)
- Avoid deeply nested code (max 3 levels of nesting)
- No magic numbers or strings — use named constants
- Remove dead code, commented-out code blocks, and unused imports
- Functions longer than 40 lines should be flagged for refactoring

## Naming Conventions
- Variables and functions: camelCase (JS/TS) or snake_case (Python)
- Classes: PascalCase
- Constants: UPPER_SNAKE_CASE
- Names should be descriptive and self-explanatory — avoid single-letter variables (except loop indices)

## Error Handling
- All async operations must have error handling (try/catch or .catch())
- Errors must not be silently swallowed — log or propagate them
- Provide meaningful error messages

## Security
- No hardcoded secrets, API keys, passwords, or tokens
- Validate and sanitize all external inputs
- Avoid `eval()`, `exec()`, or equivalent dynamic code execution
- No use of `dangerouslySetInnerHTML` without explicit justification

## Testing
- New functions/methods should have corresponding unit tests
- Tests must cover both happy path and edge cases
- No test code (mocks, stubs) should leak into production code

## Documentation
- Public functions and classes must have docstrings/JSDoc comments
- Complex logic must have inline comments explaining "why", not "what"
- README should be updated for any new features or breaking changes

## Performance
- Avoid O(n²) algorithms when O(n) or O(n log n) alternatives exist
- No unnecessary re-renders in React components
- Database queries must not be made inside loops

## Git & PR Hygiene
- Each commit should represent a single logical change
- No merge commits inside a feature branch — prefer rebase
- PR should not mix refactoring with new features
