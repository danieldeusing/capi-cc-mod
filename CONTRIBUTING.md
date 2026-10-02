# Contributing

Thanks for wanting to make Capi better. Bug reports, wrong facts, new languages
and code are all welcome.

## Reporting

- **A wrong fact on a card:** press 🚩 twice first; Capi drops the card and
  re-checks it. If the same kind of mistake keeps coming, open an issue with the
  card's text.
- **A bug:** open an issue with your Claude Code version (`claude --version`),
  whether it happens in the terminal or the Desktop app, what you did and what you
  saw. A screenshot of the band helps.

## Changing the code

`main` is protected: every change goes through a pull request, and the checks
must pass before it is merged.

1. Fork the repository and create a branch.
2. Make the change. Keep it small and focused on one thing.
3. Run all three checks:

   ```bash
   node --test test/*.test.mjs       # the learning logic; CI runs this one too
   claude plugin test                # the wiring, in Claude Code's own test kit
   claude plugin validate . --strict # what Claude Code reads from the mod
   ```

   CI can only run the first, so say in the pull request that you ran the other two.
4. A change in behaviour comes with a test that fails without it.
5. Open the pull request and describe what changed and why.

## Trying your change live

Load your clone with `claude --plugin-dir <your clone>`. Edits reload when you run
`/reload-plugins` in that session.

## Style

Plain JavaScript, no build step and no dependencies. Match the code around your
change: its naming, its comments and its spacing.

By contributing you agree that your work is published under the
[MIT License](LICENSE).
