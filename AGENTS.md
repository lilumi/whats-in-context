# What's in context

## Delivering a feature or fix

1. Implement the change and its unit tests in the main session.
2. When the tests pass, spawn the `qa` and `code-reviewer` subagents in parallel. Give each a brief that says what the change is meant to do and which files it touches - they start with no knowledge of the conversation.
3. Fix what they report, and re-run the agent whose findings you fixed if the fix was more than a few lines.
4. Report the QA results and review findings to the user before committing.

Skip steps 2-4 for changes to docs, comments or config only.
